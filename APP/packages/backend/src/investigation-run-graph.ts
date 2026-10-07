import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { GitHubCatalogAction, InvestigationService } from "@investia/core";

export interface InvestigationActionRunner {
  run(investigationId: string): Promise<GitHubCatalogAction | undefined>;
}

const RunState = Annotation.Root({
  investigationId: Annotation<string>(),
  revision: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 }),
  actionId: Annotation<string | null>({ reducer: (_current, update) => update, default: () => null }),
});

/**
 * LangGraph coordinates one service dispatch. PostgreSQL remains the only execution gate;
 * checkpoints intentionally contain identifiers and revisions, never action/evidence payloads.
 */
export function createInvestigationRunGraph(
  service: Pick<InvestigationService, "executeNextAction" | "loadInvestigation">,
  checkpointer: BaseCheckpointSaver,
): InvestigationActionRunner {
  return {
    async run(investigationId: string): Promise<GitHubCatalogAction | undefined> {
      let dispatchedAction: GitHubCatalogAction | undefined;
      const graphWithCapturedDispatch = new StateGraph(RunState)
        .addNode("dispatch", async ({ investigationId: id }) => {
          dispatchedAction = await service.executeNextAction(id);
          const current = await service.loadInvestigation(id);
          if (current === undefined) throw new Error("Investigation disappeared after action dispatch.");
          return { actionId: dispatchedAction?.id ?? null, revision: current.revision };
        })
        .addEdge(START, "dispatch")
        .addEdge("dispatch", END)
        .compile({ checkpointer });

      let state: Awaited<ReturnType<typeof graphWithCapturedDispatch.invoke>>;
      try {
        state = await graphWithCapturedDispatch.invoke(
          { investigationId, revision: 0, actionId: null },
          { configurable: { thread_id: investigationId } },
        );
      } catch (error) {
        // A checkpoint write can fail after the service committed. Return that persisted service
        // result instead of falsely reporting a failed run or letting a caller dispatch it again.
        if (dispatchedAction !== undefined) return dispatchedAction;
        throw error;
      }

      if (state.actionId === null) return undefined;
      if (dispatchedAction?.id === state.actionId) return dispatchedAction;
      const persisted = await service.loadInvestigation(investigationId);
      return persisted?.actions.find((action) => action.id === state.actionId);
    },
  };
}
