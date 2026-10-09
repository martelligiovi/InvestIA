import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import neo4j from "neo4j-driver";
import { Pool } from "pg";
import { createHoleheBox } from "../../adapter-holehe/src/index.ts";
import {
  createInvestigationService,
  createSeedBoxExecutor,
  type InvestigationExecutor,
} from "@investia/core";
import { createBackendApp } from "./api.ts";
import { AutomaticInvestigationRunner } from "./automatic-investigation-runner.ts";
import { isAllowedBackendHost, loadBackendConfig, type BackendConfig } from "./config.ts";
import { createInvestigationRunGraph } from "./investigation-run-graph.ts";
import { Neo4jInvestigationProjector, type Neo4jDriverLike } from "./neo4j-investigation-projector.ts";
import { PostgresInvestigationStore } from "./postgres-investigation-store.ts";

export interface BackendStartOptions {
  readonly pool?: Pool;
  readonly executor?: InvestigationExecutor;
  readonly neo4jDriver?: Neo4jDriverLike;
  /** In-memory savers are for offline tests only; production defaults to PostgresSaver. */
  readonly checkpointer?: BaseCheckpointSaver;
  /** Temporary frontend root override for startup tests; never read from environment. */
  readonly frontendDistPath?: string;
}

export async function startBackend(config: BackendConfig, options: BackendStartOptions = {}) {
  if (!isAllowedBackendHost(config.host, config.containerNetworking)) {
    throw new Error("HOST must be a loopback IP address (or 0.0.0.0 with explicit container networking).");
  }
  const pool = options.pool ?? new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "investia-backend",
  });
  pool.on("error", () => {
    // node-postgres discards idle clients that fail; never log connection details or credentials.
  });

  let app: ReturnType<typeof createBackendApp> | undefined;
  let driver: Neo4jDriverLike | undefined;
  let automaticRunner: AutomaticInvestigationRunner | undefined;
  try {
    driver = options.neo4jDriver ?? neo4j.driver(
      config.neo4jUri,
      neo4j.auth.basic(config.neo4jUsername, config.neo4jPassword),
      { maxConnectionPoolSize: 10 },
    );
    const store = new PostgresInvestigationStore(pool);
    await store.migrate();
    const checkpointer = options.checkpointer ?? new PostgresSaver(pool);
    if (options.checkpointer === undefined) await (checkpointer as PostgresSaver).setup();
    const service = createInvestigationService({
      store,
      executor: options.executor ?? createSeedBoxExecutor(createHoleheBox()),
      clock: () => new Date().toISOString(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    });
    const projector = new Neo4jInvestigationProjector(driver, config.neo4jDatabase);
    automaticRunner = new AutomaticInvestigationRunner(service, {
      onError: () => console.error("Automatic investigation sweep failed; persisted claims are not retried."),
      afterDispatch: async (id) => {
        const persisted = await service.loadInvestigation(id);
        if (persisted !== undefined) await projector.project(persisted);
      },
    });
    app = createBackendApp(service, {
      actionRunner: createInvestigationRunGraph(service, checkpointer),
      projector,
    }, {
      frontendDistPath: options.frontendDistPath,
      onFrontendUnavailable: () => console.info(
        "Frontend build is missing; the backend is API-only. Build it with `pnpm --dir APP --filter @investia/frontend build`.",
      ),
    });
    app.addHook("onClose", async () => { await automaticRunner!.stop(); });
    await app.listen({ host: config.host, port: config.port });
    automaticRunner.start();
  } catch (error) {
    await automaticRunner?.stop();
    if (app !== undefined) await app.close().catch(() => undefined);
    await Promise.allSettled([pool.end(), driver?.close() ?? Promise.resolve()]);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    app,
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          await automaticRunner!.stop();
          await app!.close();
        } finally {
          const results = await Promise.allSettled([pool.end(), driver?.close() ?? Promise.resolve()]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      })();
      return closing;
    },
  };
}

export async function runBackend(): Promise<void> {
  const runtime = await startBackend(loadBackendConfig());
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runBackend().catch(() => {
    console.error("Backend startup failed; check local configuration and PostgreSQL availability.");
    process.exitCode = 1;
  });
}
