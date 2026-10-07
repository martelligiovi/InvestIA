# Contributing

Use GitHub Flow: keep `main` stable, make one focused change on a short-lived
branch, and merge a reviewed, checked pull request with **Squash and merge**.
GitHub settings are active; the workflow branch still needs PR integration into
`main`. See the activation record below for exact hosted-check evidence.

## Quick path

1. Start from an up-to-date `main`, the published default branch.
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

## GitHub activation status and owner checklist

### Observed activation

Authorized publication and settings changes succeeded: remote `main` is at baseline
`b7e9859`, and `chore/git-workflow` was published at
`1907743848373eabc1d35c89087280bc201bcdc8`. The default branch is `main`;
**squash merging only** and automatic deletion of merged head branches are enabled.

Hosted **Offline checks** passed in run `37672500866` on that exact workflow-branch
commit (GitHub Actions app ID `15368`). Protection readback for `main` requires a
PR and **Offline checks**, with strict/up-to-date checks enabled (`strict=true`,
app ID `15368`). Protections apply to administrators and require linear history
and conversation resolution. Required approvals are zero for the solo owner;
force pushes and branch deletion are disabled.

**Pending:** no PR has been created or merged. The workflow code remains on
`chore/git-workflow`; `main` contains only the baseline. PR integration still
requires separate authorization. New commits require their own hosted runs; the
recorded success does not establish success for any later head.

### Reproducible maintainer checklist (guidance, not execution evidence)

1. Obtain explicit authorization before publishing branches or opening/merging the
   workflow PR. Confirm the intended baseline before publishing.
2. Publish remote `main` and the workflow branch as authorized, set the repository
   default branch to `main`, and target the workflow PR at `main`.
3. Under pull request settings, enable **squash merging only**; disable merge commits
   and rebase merging. Enable automatic deletion of merged head branches.
4. Run this workflow on GitHub and inspect the actual **Offline checks** result for
   the exact commit. Do not require an unobserved/nonexistent status check or claim
   local runs are hosted evidence. Verify new hosted runs for subsequent commits.
5. Protect `main`: require a PR, disallow force pushes and branch deletion, and
   require the observed **Offline checks** check with its GitHub Actions app selector
   and strict/up-to-date checks. Apply protections to administrators; require linear
   history and conversation resolution. Do not weaken protections to bypass failures.
6. Keep required approving reviews **optional for a solo owner** (zero required
   approvals) so an author cannot be blocked on impossible self-approval. Request
   independent review when available; revisit mandatory approval counts when
   another maintainer can actually approve.
7. Verify the default branch, merge options, cleanup, protections, and check selector
   in GitHub. Record observed activation and pending PR integration separately;
   this checklist alone activates nothing.
