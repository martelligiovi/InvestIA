# Lightweight Git workflow

## Decision and scope
GitHub Flow: stable main, short-lived feat/fix/chore/docs branches, PRs, green CI, squash merges and version tags for actual releases. No permanent develop/release branch. Solo-owner required approvals start at zero to avoid self-approval deadlock. User authorized local implementation; new push/PR/merge/settings changes remain separate. English artifacts; no APP behavior changes.

## Tasks and evidence
- [x] F1: Contribution guide, PR template, offline CI and narrow task ignore exception. Delegated worker (multi-file/preparation triggers), independent verification. Commit `841604d`; 207 insertions / 1 deletion. Corrected exact-version claim: Node/pnpm exact, Python latest 3.11 patch.
- [x] F2: Independent verification and evidence. Delegated verifier for commands; commit `1030f33`. Writer and independent verifier both observed build/typecheck passing, workspace tests 110 passed / five expected DB skips, Python tests five passed. PyYAML 6.0.3 parsing, manual workflow review, ignore probes and staged whitespace checks passed. No meaningful RED for passive workflow/docs.
- [x] F3: Final local readback and closure record complete. Inline docs/Git state; readback confirmed clean intended scope, main at b7e9859 and isolated workflow commits. This record is the closure work unit; its commit identity is recorded externally to avoid self-reference.

## Workflow contract
CI: Ubuntu 24.04, Node 24.14.0, packageManager pnpm 11.17.0, Python 3.11. Stable check Offline checks; frozen install, build before workspace tests, typecheck, Python unittest. Push all branches / PR to main / manual dispatch, event-ref-separated concurrency, 15-minute timeout. contents: read, no secrets/services/pull_request_target. CONTRIBUTING.md documents branch/commit/release/revert policy and GitHub activation; .github/pull_request_template.md provides review checklist.

## Limitations and remaining activation
Local Node 24.18.0 differs from CI pin; Python 3.11.9. Frozen install and hosted CI not run; existing dependencies used. actionlint/act/gh unavailable; YAML parsing/manual review are not hosted validation. Actions use mutable major tags (documented). Five DB integrations skipped; browser/live-provider/Docker checks not rerun. Native RDD globally off; assessment unavailable (package-local binary missing), independent verifier used.

Local main remains baseline b7e9859; work isolated on chore/git-workflow. Remote still defaults to fix/native-fetch-receiver. Pending explicit authorization/access: publish main/workflow branch, set default main, open/merge PR, enable squash-only/delete-head settings and protected main (PR required, no force/deletion). Require Offline checks only after actual hosted run; do not weaken existing protections. No remote changes performed.

Forecast 200-300 changed lines; current diff versus main 235 additions / one deletion before closure edits. Delivery strategy ask-on-risk; no PR prepared. Next step: obtain remote activation authorization; implementation is local only.
