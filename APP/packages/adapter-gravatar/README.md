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

## Configuration and limits

- No key is required. Gravatar documents 100 profile requests per hour without a key and 1,000 with one.
- Set `GRAVATAR_API_KEY` (free at gravatar.com/developers) to send it as a bearer token. Without a key, Gravatar returns at most four verified accounts and omits links and contact details.
- Observations echo the seed exactly as sent (trimmed); only the hash uses the lowercased email.
- The tool runs only under a case authorization that names `gravatar.email.v1`, with one lookup per email seed.

## Checks

```sh
pnpm --dir APP --filter @investia/adapter-gravatar test
pnpm --dir APP --filter @investia/adapter-gravatar typecheck
```

Tests use an injected fake `fetch`; they never contact Gravatar.
