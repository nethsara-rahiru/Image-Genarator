# Public HTTPS client API

The `/api/v1` API authenticates each client with a bearer token, without dashboard
cookies or CSRF handshakes. Tokens belong in a backend/service, never public
website JavaScript, query strings, source control or chat. No CORS access is
provided for external websites. Build a server-side integration instead.

This is one shared browser, Google session and FIFO queue. API job/output/chat
endpoints are scoped to the issuing client; everyone reaching the open dashboard can see all jobs. The `browser` scope grants control of the shared browser to trusted operators,
not isolated tenant browsers. All clients generate using the host's signed-in
Google account. Google login, MFA and security checks remain manual in Chrome.
The PC must stay awake and the app must be running.

For two PCs on the same LAN, use the guided **`node app.js --lan`** launcher
and [LAN setup guide](lan.md) instead of configuring a public domain.

## Enable HTTPS

Choose a hostname with DNS pointing to the host or its authenticated gateway.
Set these values in the host's private `.env`:

```dotenv
AUTH_REQUIRED=false
PUBLIC_ORIGIN=https://images.example.com
PORT=3030
AUTO_OPEN=false
```

No administrator bootstrap is required for the open dashboard. Set
AUTH_REQUIRED=true and provision an administrator with npm run setup-admin only
if you explicitly want optional protected access outside LAN mode.
Keep Node bound to loopback. A Caddy HTTPS reverse proxy on the same machine can
use the following configuration, replacing the example hostname with your domain:

```caddyfile
images.example.com {
    reverse_proxy 127.0.0.1:3030 {
        flush_interval -1
    }
}
```

Use a valid trusted certificate. Expose only the HTTPS proxy, not port 3030,
Chromium debug ports, VNC or an unencrypted API. Public HTTP origins remain rejected. If Node/Chrome run on a PC
behind NAT and the proxy is on a VPS, use the existing authenticated SSH gateway
instructions in deployment.md; a local Node process is not automatically public.
The dashboard is open in default/LAN mode; v1 API requests still require bearer
keys. Bearer ownership checks do not make the shared open dashboard tenant-isolated.
No public DNS, certificate or live deployment is provisioned by these code changes.

## Issue, list and revoke client tokens

Run on the host, using the same DATA_DIR/.env as the server:

```bash
npm run api-client -- create "website-backend" read,generate,browser 90
npm run api-client -- list
npm run api-client -- rotate CLIENT_ID 90
npm run api-client -- revoke CLIENT_ID
```

Creation shows the secret only once. Store it in your backend's secret store.
The server stores only its SHA-256 hash in a private file. Each client has a stable
ID, name, allowed scopes, expiry (1–365 days; default 90) and revocation flag.
Revocation is checked on every request and requires no server restart. It prevents
new API requests; it does not cancel an already accepted generation. Rotate with `rotate CLIENT_ID 90` to retain the client identity and access to
its existing jobs; the previous token becomes invalid immediately. Maximum 100 client records.

Scopes are `read` (status, jobs, chats and outputs), `generate` (enqueue/cancel/safe
retry/download-only recovery) and `browser` (start/stop/open Gemini). Default is
`read,generate`. All supplied scopes are explicit; the API never accepts dashboard
passwords or Google credentials. Each client is limited to 120 requests per minute;
An additional admission limit of 600 requests/minute per source IP bounds
authentication attempts. 429 responses include Retry-After. Poll every few seconds rather than continuously.

## Use the API

Set `IMAGE_API_TOKEN` from your secret manager and `IMAGE_API_BASE` to your HTTPS
origin. The examples use placeholders, not real credentials.

```bash
export IMAGE_API_BASE=https://images.example.com

curl --fail-with-body "$IMAGE_API_BASE/api/v1/health" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

curl --fail-with-body -X POST "$IMAGE_API_BASE/api/v1/browser/start" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

curl --fail-with-body -X POST "$IMAGE_API_BASE/api/v1/browser/gemini" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"
```

The host user signs into Gemini manually in Chrome if necessary. Opening a browser
is not proof of Google authentication. Generation reports needs_login if the
observed session is not signed in. Browser control requests return 409 while a
job owns Chrome or a manual sign-in flow is active.

```bash
curl --fail-with-body -X POST "$IMAGE_API_BASE/api/v1/generations" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: request-unique-0001" \
  --data '{"prompt":"A watercolor mountain landscape at sunrise","chatId":null}'
```

Returns HTTP 202 and a job object with `id`, `state` and a Location header. Poll
that job until completed or a terminal failure. The real `chatId` and `chatUrl`
appear once Gemini creates the conversation. Choose a chat from this API client's
`GET /api/v1/chats` response to continue it. Prompts allow 1–8000 characters.
Idempotency keys are required: 8–128 letters/digits/underscore/dash. Reusing a key
with the same prompt/chat returns the original job; conflicting input fails.
Keys are scoped to the API client, so different clients can use the same key.

```bash
curl --fail-with-body "$IMAGE_API_BASE/api/v1/generations/JOB_ID" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

curl --fail-with-body "$IMAGE_API_BASE/api/v1/generations/JOB_ID/image" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" --output generated-image.png

curl --fail-with-body "$IMAGE_API_BASE/api/v1/generations/JOB_ID/metadata" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" --output metadata.json
```

Use the actual output format from the completed job when choosing a local filename.
Image responses return the actual image MIME type and a matching download filename.
Metadata contains the original prompt, chat reference and actual file metadata;
protect it like your prompts and outputs.

## Endpoints

| Method | Path under /api/v1             | Scope    | Behavior                                           |
| ------ | ------------------------------ | -------- | -------------------------------------------------- |
| GET    | /health                        | read     | Service readiness and queue busy state             |
| GET    | /browser/status                | read     | Browser state                                      |
| POST   | /browser/start                 | browser  | Start managed Chrome with saved profile            |
| POST   | /browser/stop                  | browser  | Stop when no generation owns Chrome                |
| POST   | /browser/gemini                | browser  | Start/open Gemini for manual host sign-in          |
| GET    | /chats                         | read     | This client's saved conversations                  |
| POST   | /generations                   | generate | Enqueue prompt with Idempotency-Key                |
| GET    | /generations?limit=20&offset=0 | read     | Paginated own jobs; limit 1–100                    |
| GET    | /generations/:id               | read     | Own job state, progress, chat ID and errors        |
| POST   | /generations/:id/cancel        | generate | Cancel own job; submitted prompt remains in Gemini |
| POST   | /generations/:id/retry         | generate | Retry only if submission could not have occurred   |
| POST   | /generations/:id/recover       | generate | Download existing image without a new prompt       |
| GET    | /generations/:id/image         | read     | Completed original image                           |
| GET    | /generations/:id/metadata      | read     | Completed output metadata JSON                     |

Unknown/other-client jobs return 404. Invalid/expired/revoked credentials return
401, missing scopes return 403, unfinished outputs and busy controls return 409.
Validation failures return 400 with a sanitized error/code. No credentials, API
client administration, arbitrary browser actions, JavaScript execution, profile
files or browser debug ports are exposed through this API. Existing `/api/*`
dashboard endpoints retain their separate session/CSRF rules.

Automated API tests use local fixtures. Real public DNS/TLS, the target machine's
browser, Google sign-in and live Gemini generation require deployment validation.

A completed job may report browserCleanupPending=true while its image/metadata
are already downloadable. The queue holds the browser until cleanup finishes;
clients should use job state rather than queueBusy to decide if output is ready.

## API request diagnostics

The dashboard's **API requests** table shows the latest 100 retained API requests,
newest first: time, method, matched route, HTTP status, duration and job/request
ID. History shares the bounded persistent debug journal and updates live. Use
Debug console → Source → API to filter/export these events. Each API response
includes `X-Request-Id` for correlation. Tokens, prompts, request bodies, query
strings and arbitrary unmatched URLs are omitted; unknown routes show `unmatched`.

If no automation starts, check the request row first:

- `404`: use **POST /api/v1/generations**, with forward slashes and that spelling.
- `400` with `GENERATION_IDEMPOTENCY_KEY_REQUIRED`: set `Idempotency-Key` to
  8–128 letters/digits/underscores/dashes in Postman's Headers tab.
- `401` / `403`: check the bearer token, `generate` scope, HTTPS and configured Host.
- `409`: finish the manual sign-in flow or inspect the browser ownership message.
- `202`: a job was accepted. Poll its Location URL; check `state` and `error`.
  Reusing the same key returns the old job and does not start a new generation.
  Use a new key for a new prompt. Never retry an ambiguous submitted prompt blindly.

A missing API table row suggests the request did not reach this running app
(e.g. a wrong port, unavailable tunnel, or TLS failure). Google sign-in remains
manual in the host browser. Live Gemini generation requires target-PC validation.

## Reference images

The generator accepts up to **4 PNG, JPEG or WebP images, 10 MB each**. Select
Reference images in the dashboard, review the previews, remove any unwanted files,
and submit the prompt. The server checks actual file bytes, stores randomized
private filenames with the durable job, uploads them to Gemini and confirms all
attachment names in the composer before submitting. A missing/ambiguous upload
control or unconfirmed attachment stops the job without sending a prompt.

For the API, use the existing `POST /api/v1/generations` endpoint with
`multipart/form-data`. Repeat the **references** file field for each image. Keep
`prompt` as text; omit `chatId` for a new chat. JSON requests without files still
work. Do not manually set Content-Type: your client must include its multipart
boundary. Bearer scopes, ownership and idempotency rules still apply.

```bash
curl --fail-with-body "$IMAGE_API_BASE/api/v1/generations" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" \
  -H "Idempotency-Key: reference-request-0001" \
  -F 'prompt=Create a product poster using this logo and reference style' \
  -F 'references=@/path/to/logo.png' \
  -F 'references=@/path/to/style.jpg'
```

In Postman select **Body → form-data**: `prompt` = Text, `references` = File
(repeat for more images). Set Authorization to Bearer Token and supply a fresh
Idempotency-Key for each new generation. Repeating a request with the same key
must include the same prompt, chat and ordered reference names/bytes; changed
references produce a conflict. Do not use a fresh key merely to retry an ambiguous
submitted prompt.

Job JSON includes reference descriptors (sanitized input name, checksum, format,
size and randomized filename), never server paths or file contents. Output
metadata includes `inputAssetNames`. Images are retained with their job for safe
pre-submission retries and restart recovery, included in runtime backups, and
deleted with the local job/output. Inputs have no public download endpoint.
Download-only recovery does not upload references or resubmit a prompt. Manual
Google sign-in remains unchanged. Real Chromium fixture uploads are tested; live
Google/Gemini attachment behavior is **UNVERIFIED** until tested on the host PC.
