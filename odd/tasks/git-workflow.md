# Lightweight Git workflow

## Decision and authorization
GitHub Flow: stable main, short-lived branches, PRs with green CI, squash merges, actual-release tags. No permanent develop/release branches. Solo-owner required approvals zero. User first authorized implementation, then explicitly authorized publishing main/workflow changes and default/protection settings. No force push, deletion, PR creation or merge performed.

## Tasks and evidence
- [x] F1: Guide, PR template, CI and ignore exception. Delegated worker plus independent verifier; commit841604d (207 insertions/1 deletion). Python3.11 latest patch, exact Node/pnpm.
- [x] F2: Independent verification evidence commit1030f33. Build/typechecks passed, workspace110 passed/five DB skips, Python five passed. YAML parsed (PyYAML6.0.3), manual review, ignore/whitespace checks passed. Passive config/docs: no meaningful RED.
- [x] F3: Local closure commit5f342b7; clean scope, baseline main b7e9859. Aggregate original diff226 additions/one deletion. Route inline docs/Git state.
- [x] F4: Published main and chore/git-workflow; default main, squash-only, automatic head cleanup confirmed via API. Admin access via in-memory credential-manager authentication, no secret printing/storage. Tracking authorization commit1907743; settings evidence included with F5/F6 documentation work unit.
- [x] F5: Delegated verifier observed exact hosted CI success: run37672500866, SHA1907743848373eabc1d35c89087280bc201bcdc8, Offline checks app15368. Main protection applied and API readback confirmed: PR required, strict Offline checks bound to app15368, enforce admins, linear history/conversation resolution, zero required approvals, force push/deletion prohibited. No prior protections/rulesets overwritten. Settings evidence documentation work unit closes F4/F5 together.
- [x] F6: Accurate activation evidence and remaining PR integration recorded. Delegated documentation worker for CONTRIBUTING, parent tracking/Git state. This documentation is the activation work unit; publication identity and final-head hosted verification are recorded externally to avoid self-referential evidence commits. Do not extend observed hosted success to new commits. PR integration needs separate authorization.

## Workflow and limitations
CI Ubuntu24.04/Node24.14.0/pnpm11.17.0/Python3.11: frozen install, build before workspace tests, typecheck, Python unittest; contents read, no secrets/services/pull_request_target, push branches/PR main/manual, event-ref concurrency,15min timeout. CONTRIBUTING and PR template define daily workflow/reverts/releases. Local Node24.18 differed; hosted CI now observed on exact1907743. Five DB integrations deliberately skipped; browser/live-provider/Docker not rerun. gh/actionlint/act absent; native RDD globally off and assessment unavailable, independent verifier used. Mutable action major tags remain a documented limitation.

## Remote state and next step
main published at baseline b7e9859 and protected/default. Workflow code is on chore/git-workflow, NOT integrated into main. Original fix/native-fetch-receiver preserved. Repo settings verified by API, check run URL https://github.com/martelligiovi/InvestIA/actions/runs/37672500866. No PR opened/merged, no tags/releases.
Next: obtain separate PR/merge authorization. Publication and new-head CI evidence are maintained externally; any new head needs its own CI evidence.
