## Purpose

<!-- One clear purpose. Explain why, link the task/issue, and state out-of-scope work. -->

## Review path

<!-- List the files/behaviors to review first, risks, and rollback approach. -->

## Verification

<!-- Record observed results or an explicit reason for each local check not run. -->

- [ ] `pnpm --dir APP build` (before tests)
- [ ] `pnpm --dir APP test`
- [ ] `pnpm --dir APP typecheck`
- [ ] Python 3.11: `python -B -m unittest discover -s APP/packages/adapter-holehe/python/tests -p test_holehe_bridge.py -v`
- [ ] `git diff --check`
- [ ] Expected five DB-gated skips reported separately; unexpected skips/failures explained
- [ ] Hosted **Offline checks** result inspected (do not equate local checks with hosted CI)

Results / skips / checks not run:

## Merge checklist

- [ ] One focused change; unrelated files and generated output excluded
- [ ] No secrets, live provider calls, or unauthorized database/environment use
- [ ] PR title follows Conventional Commits; target is `main`
- [ ] Review size is manageable (~400 changed lines advisory); larger scope explained
- [ ] Review feedback addressed; squash merge planned
- [ ] Rollback uses a revert rather than rewriting shared history
- [ ] No version tag/publication unless explicitly approved

See [CONTRIBUTING.md](../CONTRIBUTING.md) for checks and pending GitHub activation.
