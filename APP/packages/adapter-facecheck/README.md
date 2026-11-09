# FaceCheck adapter

`createFacecheckBox()` is the `facecheck.photo.v1` SeedBox. Its input is a photo seed: the URL of a Google profile photo that GHunt found. It follows the official FaceCheck.id API flow:

1. Download the photo. Only HTTPS `*.googleusercontent.com` and `*.ggpht.com` URLs without a query, fragment or credentials are accepted. Redirects are refused. Only JPEG, PNG, WebP or GIF images of up to 5 MB are uploaded; a larger body is refused from its declared length or as soon as it exceeds the limit while streaming.
2. `POST https://facecheck.id/api/upload_pic` with the image as multipart `images` and the header `Authorization: <token>`. The response contains an `id_search`.
3. Poll `POST https://facecheck.id/api/search` with `{ id_search, with_progress: true, status_only: false, demo }` once per second until `output` arrives. The search stops after 15 minutes.

The Google request never receives the FaceCheck token.

## Results

Each FaceCheck item is a candidate, not a confirmed identity. The 20 highest-scoring candidates become separate `Face match` findings:

| Field | Value |
|---|---|
| `url` | Source web page (`item.url.value`); absolute http(s) without credentials |
| `media.thumbnail` | Face thumbnail as a `data:image/(webp\|jpeg\|png);base64,` URL. A bare base64 value is stored as WebP. Thumbnails of up to 256 KB are kept |
| `extra.score` | FaceCheck similarity score |
| `extra.group` | FaceCheck result group, when present |
| `extra.testing_mode` | `true` when the search ran in testing mode |

Candidates with an unsafe link or thumbnail, or without a numeric score, are dropped. A search without items succeeds without evidence. The operator confirms or rejects each candidate individually in the workspace.

## Testing mode

In testing mode (`demo: true`) FaceCheck scans only 100,000 faces and does not deduct credits; results are of little use. A real search costs 3 credits. The token and the testing-mode switch are read before every search.

## Failures

| Situation | Error |
|---|---|
| No token configured | `FaceCheck API token is not configured` |
| Photo not downloadable or unusable | `FaceCheck could not download the profile photo` |
| FaceCheck reports an error | `FaceCheck: <error> (<code>)`, as one line of up to 200 characters; an echoed token is replaced by `[token]` |
| Network failure or request timeout (30 s) | `FaceCheck request failed` |
| HTTP error without a FaceCheck error | `FaceCheck request failed with HTTP <status>` |
| No result within the polling limit | `FaceCheck search did not finish in time` |

Failed actions are not retried.

## Checks

```sh
pnpm --dir APP --filter @investia/adapter-facecheck test
pnpm --dir APP --filter @investia/adapter-facecheck typecheck
```
