# Lightweight Git workflow

## Objective and decision
Use GitHub Flow: stable main, short-lived feat/fix/chore/docs branches, reviewed PRs with green CI, squash merges, annotated version tags for real releases. No permanent develop/release branches without a demonstrated need. A solo maintainer cannot self-approve, so approval counts start at zero and grow with the team.

## Authorization and scope
User authorized implementation. Local main starts at verified baseline b7e9859; implementation is on chore/git-workflow. No new push, PR, merge, remote settings change or destructive operation authorized. Remote default is still fix/native-fetch-receiver; gh CLI unavailable. Preserve APP behavior and existing task records. English artifacts.

## Tasks
- [x] F1: Implement CONTRIBUTING.md, PR template, offline CI, and narrow task ignore exception. Delegated worker (multi-file/preparation trigger), checked by independent verifier. Commit: `841604d` (`chore(git): adopt lightweight GitHub Flow with offline CI`); 207 insertions / 1 deletion. Parent corrected misleading exact-Python-version wording; Python intentionally tracks latest available 3.11 patch, Node/pnpm exact.
- [ ] F2: Commit independent verification evidence. Delegated verifier for checks; parent records results. Verification finished; evidence commit in progress.
- [ ] F3: Record closure and remaining remote activation. Inline mechanical docs/Git state. Final structural readback and closure commit pending.

## Observed checks
Writer and independent verifier each observed: frontend build passed; workspace tests 110 passed / five expected database-gated skips; workspace typecheck passed; Python bridge tests five passed. No APP source changes. Ignore probes passed; staged whitespace check passed. Independent PyYAML 6.0.3 parsing and manual workflow/event/action input/security review passed. Passive workflow/docs have no meaningful test-first RED.

CI uses Ubuntu 24.04, Node 24.14.0, packageManager-selected pnpm 11.17.0 and Python 3.11. Stable check name: Offline checks. Frozen install, build before tests, typecheck and Python unittest; contents: read, no secrets/services, no pull_request_target. Push all branches, PR to main, manual dispatch; event/ref-separated concurrency and 15-minute timeout.

## Limitations and remote activation
- Local Node 24.18.0 differs from hosted pinned Node 24.14.0; Python local 3.11.9. Frozen install not rerun; existing dependencies used. Hosted CI not observed.
- actionlint/act/gh unavailable. YAML parsing/manual inspection are not formal GitHub schema validation or hosted execution. Action major tags remain mutable; CONTRIBUTING documents the risk.
- Five DB integrations skipped; browser/live-provider/Docker checks not rerun. No secrets or external services enabled.
- Native RDD remains globally off. Read-only assessment unavailable (package-local binary missing); independent verifier completed instead.
- Pending user authorization/access: publish main and workflow branch, activate default main, PR merge and squash-only/delete-head settings. Observe Offline checks on GitHub before requiring that exact check in main protection. Require PR, prohibit force pushes/deletion; do not weaken existing protections. CONTRIBUTING contains the activation sequence.
- Forecast 200-300 authored lines; actual workflow unit 208 changed lines plus this evidence record. Delivery strategy ask-on-risk; no PR or publication performed.

## Next step
Commit this evidence record, inspect final local branches/status, record closure. Then request separate remote activation authorization.
