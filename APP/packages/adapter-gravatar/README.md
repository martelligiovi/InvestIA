# Gravatar adapter

`createGravatarBox()` is the `gravatar.email.v1` SeedBox. For an email seed it requests the public profile at `https://api.gravatar.com/v3/profiles/{hash}`, where the hash is the SHA-256 of the trimmed, lowercased email.

## Results

| Response | Observations |
|---|---|
| 200 | One `Profile` finding (display name, location, description, job title, company, pronouns, avatar) plus one `Linked account` finding per visible verified account with an http(s) URL |
| 404 | One `not_registered` result; it is not retained as evidence |
| 429 | Error `Gravatar rate limit reached; try again later.`; the action fails and is not retried |
| other | Error `Gravatar request failed with HTTP <status>`; response bodies are never included |

Requests time out after 10 seconds.

The workspace derives a distinct discovered seed for each nonempty collected profile field, profile URL, avatar/media URL and linked-account URL. Each seed retains its original evidence and producing action; branches stay aligned with that action. Existing saved profiles work without another lookup or a data migration. Selecting a seed does not run a search. Evidence validation applies to the complete original observation, not an individual field. A username is shown only if it is present in saved metadata; it is not inferred from a profile URL.

## Configuration and limits

- No key is required. Gravatar documents 100 profile requests per hour without a key and 1,000 with one.
- Set `GRAVATAR_API_KEY` (free at gravatar.com/developers) to send it as a bearer token. Without a key, Gravatar returns at most four verified accounts and omits links and contact details.
- Observations echo the seed exactly as sent (trimmed); only the hash uses the lowercased email.
- After a successful User Scanner scan, a positive Gravatar finding queues a lookup linked to that finding, for the email it reports (or the scanned email when it reports only a username or an unusable address); a negative scan creates a proposed action, which the operator can select and approve with a reason. A failed scan does not create a proposal.
- The tool runs only under a case authorization that names `gravatar.email.v1` and when the case is unpaused. Automatic mode processes eligible queued actions; manual mode requires the case-level run-next control.

## Checks

```sh
pnpm --dir APP --filter @investia/adapter-gravatar test
pnpm --dir APP --filter @investia/adapter-gravatar typecheck
```

Tests use an injected fake `fetch`; they never contact Gravatar.
