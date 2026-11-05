# GHunt email adapter

A standalone, injectable SeedBox for `gmail.com` and `googlemail.com` email seeds. It is not connected to the application queue, login, UI, or container. Run only with the operator's authorization; the offline tests never contact Google.

`createGhuntBox(runner)` requires an injected runner. `createGhuntProcessRunner({ sessionHome, pythonExecutable })` runs GHunt without a shell using `python -B -c 'from ghunt.ghunt import main; main()' email --json <report> -- <email>`. The option terminator protects service-valid local parts starting with `-`; the authentic GHunt 2.3.4 argument parser accepts it (verified offline against the wheel's `cli.py`). The caller must supply an existing, absolute, persistent **private** credential home; the runner sets both HOME and USERPROFILE to it. On POSIX the runner rejects a home not owned by the current user or accessible by group/other mode bits. On Windows POSIX mode bits do not verify ACL privacy: the caller must provision and verify an appropriately restricted ACL. The caller must also secure parent directories, ACLs on all platforms, and the output root; mode checks do not prove privacy against privileged users or races. GHunt may refresh credentials there. Do not use a temporary report directory as the credential home, share it between users, or log its contents. The caller owns authorization, session lifecycle and isolation, including concurrent access. No login is implemented here.

Reports use a fresh temporary directory, removed after each run; stdout and stderr are drained; only a bounded 4 KiB tail is kept in memory to classify failures and is never surfaced. Time and output limits apply. A successful exit without a JSON report is `missing_report`, not a positive result or proof that the account does not exist. A nonzero exit reporting that the target was not found or is not a public Google account is `not_found`, and the box returns no finding. An upstream `GHuntInvalidSession` or `GHuntLoginError` is `invalid_session`. Other failures have generic codes. Profile extraction only accepts a PROFILE_CONTAINER profile with personId and retains the ID, full name and a non-default HTTPS photo without query, fragment or userinfo. The report may contain private data; it is not returned as a finding. `test/fixtures/ghunt-2.3.4-email-report.json` was produced offline by the authentic 2.3.4 `Person` objects and `GHuntEncoder` with synthetic values, not by a live scan. GHunt 2.3.4 no longer populates names, so `fullname` is normally absent.

GHunt itself is not bundled or installed by this package. Parent-verified PyPI wheel `ghunt==2.3.4` has SHA-256 `7b880072131b7a064e6500b9db2f64bd33eb3b396702825330c507243b617f4d`; provisioning its complete dependencies and isolated interpreter is a later packaging task. Do not install globally. This adapter has not executed upstream GHunt or verified cross-platform session behavior.

Offline checks from the repository root:

```sh
node --experimental-strip-types --test APP/packages/adapter-ghunt/test/*.test.ts
node APP/node_modules/typescript/bin/tsc --noEmit -p APP/packages/adapter-ghunt/tsconfig.json
```
