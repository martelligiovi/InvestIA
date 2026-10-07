# Contributing

Use GitHub Flow: keep `main` stable, make one focused change on a short-lived
branch, and merge a reviewed, checked pull request with **Squash and merge**.
This guide defines the intended workflow; GitHub activation is still pending.

## Quick path

1. Start from an up-to-date `main` once it is published as the default branch.
2. Create a short-lived branch: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`,
   `chore/<topic>`, `refactor/<topic>`, or `test/<topic>`.
3. Keep one clear purpose per PR. Separate unrelated cleanup or behavior changes.
4. Run the checks below and describe results, skips, risks, and the review path.
5. Open a PR into `main`; address feedback and wait for CI before squash merging.
6. Delete the merged branch. Do not maintain permanent `develop` or release branches
   without a demonstrated need.

Use Conventional Commits for commit messages and the PR title (the squash commit):
`feat: add search filter`, `fix(api): handle missing result`, or
`docs: clarify setup`. Use `!` and a `BREAKING CHANGE:` footer for breaking changes.
Keep the squash message useful as a durable explanation of intent.

## Review size and scope

Aim for roughly **400 changed lines or fewer** when practical. This is an advisory
review budget, not a gate: do not compress code, remove explanations, or split a
coherent change artificially to hit it. Explain larger changes and give reviewers
an ordered path. State what is deliberately out of scope. Check for accidental
secrets, generated output, unrelated files, and behavior changes.

## Local checks and CI

Use Node **24.14.0**, pnpm **11.17.0** (also pinned by `APP/package.json`), and
Python **3.11**. From the repository root, with dependencies already installed:

```sh
pnpm --dir APP build
pnpm --dir APP test
pnpm --dir APP typecheck
python -B -m unittest discover -s APP/packages/adapter-holehe/python/tests -p test_holehe_bridge.py -v
git diff --check
```

Use your Python 3.11 interpreter path if `python` selects another version. On
Windows, an existing project virtual environment can be invoked with
`APP/.venv/Scripts/python.exe` in place of `python`.
For initial dependency setup, CI uses `pnpm --dir APP install --frozen-lockfile`;
do not silently regenerate the lockfile to bypass installation failures.

**Build before tests**: backend static-serving tests need the compiled frontend.
The workspace commands cover application tests and typechecks. Python bridge
unit tests inject dependencies; they need neither Holehe installation nor live
provider calls.

The GitHub Actions workflow is **CI** and its single job/check name is
**Offline checks** (job ID `offline-checks`). Select the observed **Offline checks**
status check in branch protection, not a guessed label. It runs on all branch
pushes, PRs targeting `main`, and manual dispatches. Concurrency cancels superseded
runs within the same event/ref, without push/PR runs canceling each other.

CI deliberately has no database services, secrets, or environment-template
loading. With no dedicated integration configuration, **five DB-gated tests are
expected to skip** (PostgreSQL, Neo4j, and combined workflow integration coverage).
These skips are not evidence that integrations passed. Report unexpected skips
or failures; do not weaken tests to make checks green. Live integration checks
require separate authorization and dedicated test infrastructure. For docs-only
local work, explain any checks not run; the required hosted check still applies
once activated.

Actions use standard `actions/checkout@v4`, `actions/setup-node@v4`,
`actions/setup-python@v5`, and `pnpm/action-setup@v4`. Node and pnpm versions
are exact; Python tracks the latest available 3.11 patch. Action major tags are
mutable: upstream updates can change the action code.
Full reviewed commit-SHA pinning is a future hardening option, not a guarantee
provided by this workflow. Permissions are limited to `contents: read`.

## Releases and rollback

A merge is not a release. Create annotated version tags such as `v0.1.0` only
with **explicit publication approval** for the target commit and release. Tags,
pushes, releases, and package publication are not authorized by this guide.
Do not create version tags for routine work or move a published version tag.

Prefer a revert PR over rewriting shared history when undoing a merged change.
Do not force-push or delete `main`; avoid resetting or rebasing published shared
history. Correct a bad release with a follow-up change and an approved new version.

## Pending GitHub activation (owner checklist)

These are manual steps, **not active settings or completed remote work**. The
remote default is currently `fix/native-fetch-receiver`; local `main` exists.

1. Obtain explicit authorization to publish local `main`, push this workflow branch,
   and open/merge the workflow PR. Confirm the intended baseline before publishing.
2. After authorized creation/push of remote `main`, set the repository default branch
   to `main` in GitHub settings. Target the workflow PR at `main`.
3. Under pull request settings, enable **squash merging only**; disable merge commits
   and rebase merging. Enable automatic deletion of merged head branches.
4. Run this workflow on GitHub and inspect the actual **Offline checks** result.
   Do not require an unobserved/nonexistent status check or claim local runs are
   hosted evidence.
5. Protect `main`: require a PR before merging, disallow force pushes and branch
   deletion, and require the observed **Offline checks** check only after that run.
   Apply protections to administrators where appropriate; do not weaken them to
   bypass failures.
6. Keep required approving reviews **optional for a solo owner** (zero required
   approvals) so an author cannot be blocked on impossible self-approval. Request
   independent review when available; revisit mandatory approval counts when
   another maintainer can actually approve.
7. Verify the default branch, merge options, cleanup, protections, and check selector
   in GitHub. Record observed activation separately; this document alone activates
   nothing.
