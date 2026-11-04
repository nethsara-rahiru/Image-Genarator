# Local Gemini Image Generator

Run a local image-generation dashboard and a dedicated Chrome/Edge browser on
your PC. Enter a description, create or resume a Gemini chat, and download one
original generated image with its actual chat ID and metadata. The local app
opens without an administrator login. Google sign-in is separate and still
required; Google may reject automated browsers or decline to generate an image.

## Contents

- [Run locally](#run-locally)
- [Generate images and get chat IDs](#generate-an-image-and-get-the-chat-id)
- [Postman and API setup](#api-setup-for-postman-and-other-applications)
- [Complete client API list](#complete-client-api-list)
- [Requests, progress and image outputs](#postman-workflow-open-browser--generate--retrieve-output)
- [curl examples](#curl-examples)
- [Errors and limits](#api-errors-limits-and-troubleshooting)
- [Dashboard-only APIs](#dashboard-only-endpoint-list)

## Run locally

Install Node.js 22+ and ordinary Google Chrome (Edge is detected as a fallback),
then run from this repository:

```sh
npm ci
node app.js
```

Open **http://127.0.0.1:3030**. There is no first-run username/password prompt and
no database setup. Existing administrator files are preserved but ignored in the
default local mode. No `.env` is necessary for defaults. If reusing an older
`.env`, set `AUTH_REQUIRED=false` and
`PUBLIC_ORIGIN=http://127.0.0.1:3030`; HTTPS is still required for network access.

The OS is detected automatically. Native Windows/macOS control can require the
managed window to remain visible and can change desktop focus:

- **Windows:** use an unlocked desktop with Chrome unminimized. The bundled
  PowerShell helper captures only the managed window. Enterprise policy may
  require approval for the trusted helper; do not disable organizational controls.
- **macOS:** grant Screen Recording, Accessibility and Automation permissions to
  the terminal/Node when needed. `npm run doctor` provides read-only diagnostics;
  `npm run doctor -- --launch` additionally tests an isolated blank window.
- **Linux:** run `npm run setup-host` to detect/install Xvfb, xauth, xdotool,
  Openbox, ImageMagick, xprop and D-Bus on supported Debian/Ubuntu systems. Install
  Chrome if missing. The private virtual display does not control your host desktop.

Set `CHROME_PATH` only for a nonstandard install. Never run the app/browser as
root or disable Chromium's sandbox for production.

## Generate an image and get the chat ID

1. Choose **Open Gemini / sign in**. If signed out, sign in manually in the
   opened Chrome window, including verification, then choose **Check again**.
   The app never collects Google credentials or automates sign-in. Generation
   remains blocked until Gemini shows a signed-in account and editor. Browser
   preview streaming is disabled; use the Chrome window directly.
2. In **Image generator**, choose **New chat** or a saved conversation and enter
   the image description. **Generate image** returns a job immediately. The app
   submits `Create an image based on this description:` followed by your prompt.
3. Watch the real job stages. Jobs run in FIFO order, one at a time. Manual
   controls are blocked while a generation job owns the browser.
4. When Gemini creates its conversation URL, the dashboard shows the actual
   **Chat ID** and link. No local placeholder is returned as a Gemini chat ID.
5. On success, preview/download the original image and metadata JSON. The first
   valid image in the latest new model response is selected; older chat images
   are excluded. PNG/JPEG/WebP signatures, actual dimensions, size and checksum
   are checked. No image-content analysis or bounding boxes are produced.

Saved chats can be resumed and renamed locally. A chat is bound to the Google
account observed when it was tracked; switching accounts does not silently
submit to another account's conversation. Conversation deletion is not automated.
Removing a local job/output leaves the Google conversation intact.

Gemini may return text only, fail to generate, impose limits, or change its UI.
These are explicit job failures or review states, not screenshots or fake images.
After ambiguous submission, interruption or restart, the app never automatically
replays the prompt. Inspect its saved chat. **Retry before submission** is offered
only when no prompt submission could have occurred. Cancel stops waiting/downloads;
it cannot undo a prompt already submitted to Gemini.

## Background browser

For background control without macOS/Windows screen/input permissions, install
and start Docker Desktop with Linux containers, then run:

```sh
node app.js --background
# equivalent: npm run background
```

The first run builds the Linux desktop image, without asking for an app password.
Open the same local URL after `SERVICE_STARTED`. Stop another app already using
port 3030 first. On Linux this mode uses a local Docker engine; native Linux also
supports its private desktop directly without Docker.

The container runs as a mapped non-root user, keeps Chromium's sandbox enabled,
publishes only host loopback, and exposes no VNC/CDP/debugging network listener.
Keep Node, Docker and the PC running and awake. Disconnecting the dashboard does
not stop a job; cancellation, shutdown and timeouts do. Ctrl+C stops this launch's
container and preserves its profile. Reserve 2 CPUs, about 4 GB RAM and disk space.
Physical Docker Desktop/ARM compatibility still needs target validation.

Background data is separate, under `DATA_DIR/background` (default
`runtime/background`). Native and background sessions do not import each other's
cookies or your personal Chrome profile. See [container notes](container/README.md)
for sandbox/engine diagnostics.

## Advanced settings and browser controls

The optional **Advanced AI settings** panel retains server-side Groq configuration;
keys stay private and are never returned by APIs. The current Google sign-in flow
is fully manual and does not invoke Groq or collect credentials. Generation uses
guarded deterministic controls and pauses when the prompt/response/download UI
cannot be verified.

Browser controls are collapsed under **Tools & settings**. They provide Google
search, native tabs, text entry, upload through a native file chooser (20 MB),
browser downloads and a sanitized debug console. Use the actual Chrome window
for typing, sign-in and native popups. There is no browser preview in the app.
Generated-image previews remain available in Jobs & results.

## Storage, access and recovery

`DATA_DIR` defaults to `runtime/`. Protect this directory: it contains Google
sessions, prompts, generated files, chat references and server secrets. Generation
state lives in `generation/queue.json`; outputs and JSON are under
`generation/outputs/<job-id>/`. The queue has a process lease and atomic writes.
An interrupted potentially submitted job becomes `needs_review` after restart.
Default limits: 50 pending jobs, 500 retained jobs, 100 MB per completed image and
180 seconds per generation job. Remove older local jobs/outputs to reclaim space;
partial browser files and profiles can still consume disk, so use OS quotas.

Back up the whole data directory only while the app is stopped; restore with the
same private permissions. Never commit it, `.env`, logs or screenshots containing
real user data. **The dashboard is shared and open by default**: anyone who can reach it can
control the saved browser and read the workspace. Node binds to 127.0.0.1; use
`node app.js --lan` for managed HTTPS access on your local network. HTTPS/Host/Origin
and CSRF checks remain enabled. Bearer-token v1 APIs still require API credentials.

Optional legacy protected access requires `AUTH_REQUIRED=true`, secure CLI setup
with `npm run setup-admin`, and valid TLS for a public origin. This is opt-in and
does not reintroduce a default startup login. See [deployment](docs/deployment.md),
[API](docs/api.md), [security](docs/security.md) and [operations](docs/operations.md).

## Validation and limitations

```sh
npm test
npm run lint
npm run doctor
```

Tests include API/security, durable FIFO/recovery, image metadata, local
Gemini-like browser fixtures, original image downloads, resumed chats, historical
image exclusion, multiple images, no-image/login/account/cancel/download failures,
and responsive no-login UI. CI also checks the production sandbox/private pipe.
Fixture success is not proof of live Google/Gemini operation.

**UNVERIFIED:** real Google sign-in and Gemini image-generation/download UI,
actual Groq/model availability, and physical Windows/macOS/ARM acceptance.
Google's reported insecure-browser rejection cannot be bypassed or guaranteed
away by this app. Complete live validation on your own account/PC before relying
on unattended operation; see [test report](docs/test-report.md).

## API setup for Postman and other applications

Use **`/api/v1`** for server-to-server clients and Postman. Every request requires
an API bearer token, even when the local dashboard has no application login.
The API controls one shared host browser/Google session and one global FIFO queue.
Clients can list/read/control only their own jobs through v1; the open dashboard
exposes the shared workspace to everyone who can reach it. `browser` permission is for trusted
operators of the shared browser, not isolated tenant browsers.

### Two PCs on the same LAN

Stop the previous app/Caddy, then run on the host PC:

```sh
git pull --ff-only
npm ci
node app.js --lan
```

Follow the prompts to choose your Wi-Fi/Ethernet IP. No administrator setup or
dashboard password is required in LAN mode, including with older AUTH_REQUIRED settings. The launcher manages HTTPS, leaves `.env` unchanged and
prints the actual API URL, CA certificate path/fingerprint and first API token if
no active clients exist and the terminal is interactive. Keep this terminal open;
Ctrl+C stops both services.

On the second PC:

1. Copy only the printed **Studio-LAN-CA.crt** file from the host. Never copy CA
   private keys, browser profiles or the whole runtime directory.
2. Postman → Settings → Certificates → CA Certificates → import that certificate.
   Keep SSL verification enabled. This is one-time while the host's CA is retained.
3. Create a Postman collection with variable `baseUrl` set to the printed URL,
   for example `https://192.168.1.50:3443/api/v1`.
4. Collection → Authorization → Bearer Token → enter the API token locally. Set
   each request to **Inherit auth from parent**.

No domain, Cloudflare, SSH tunnel or second Caddy terminal is needed for LAN mode.
Allow incoming Caddy connections if the host firewall asks. Both PCs must be able
to reach each other on the same network. See [LAN setup](docs/lan.md).

On the host alone, the default API base is `http://127.0.0.1:3030/api/v1`; no CA
import is needed for loopback. Public internet access requires
a configured HTTPS origin and a valid TLS gateway; `AUTH_REQUIRED=true` remains
an optional administrator-login setting outside LAN mode; see [client API deployment](docs/client-api.md).
LAN mode provides same-network access and does not make the PC publicly reachable.

### Create and manage API tokens

Run in the host's project folder, using the server's same `.env`/`DATA_DIR`:

```sh
npm run api-client -- create "postman" read,generate,browser 90
npm run api-client -- list
npm run api-client -- rotate CLIENT_ID 90
npm run api-client -- revoke CLIENT_ID
```

Creation/rotation shows the token once. Save it securely; do not commit it or share
it in chat. Only its hash is stored. Rotation preserves the client ID and existing
job access, and invalidates the old token immediately. Revocation blocks new API
requests; already accepted jobs are not automatically cancelled. Expiry is 1–365
days (default 90). Maximum 100 client records.

| Scope      | Allows                                                              |
| ---------- | ------------------------------------------------------------------- |
| `read`     | Health/browser status, own jobs/chats, original images and metadata |
| `generate` | Submit, cancel, safe retry and download-only recovery of own jobs   |
| `browser`  | Start/stop the shared browser and open Gemini                       |

Default CLI scopes are `read,generate`; include `browser` when needed. All v1
requests use `Authorization: Bearer YOUR_TOKEN`. They require no dashboard cookies,
Origin header or CSRF token. A supplied Origin must match the configured origin.
Browser websites should call this API through their backend; no external CORS or
safe storage of secrets in public frontend JavaScript is provided.

### Complete client API list

Paths below are relative to `baseUrl`, which already ends in **`/api/v1`**.
All successful responses are JSON unless marked as image bytes.

| Method | Endpoint                         | Scope    | Input                                                               | Success output                                                    |
| ------ | -------------------------------- | -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/health`                        | read     | None                                                                | 200 `{ "status": "ok", "queueBusy": false }`                      |
| GET    | `/browser/status`                | read     | None                                                                | 200 browser state plus `queueBusy`                                |
| POST   | `/browser/start`                 | browser  | No body                                                             | 200 browser state; starts/reuses saved profile                    |
| POST   | `/browser/stop`                  | browser  | No body                                                             | 200 browser state; refuses while a job owns Chrome                |
| POST   | `/browser/gemini`                | browser  | No body                                                             | 200 browser state and manual sign-in instruction                  |
| GET    | `/chats`                         | read     | None                                                                | 200 `{ "chats": [...] }` for this client                          |
| POST   | `/generations`                   | generate | JSON `prompt`, optional `chatId`; required `Idempotency-Key` header | 202 job JSON and Location header                                  |
| GET    | `/generations?limit=20&offset=0` | read     | Limit 1–100; offset ≥ 0                                             | 200 `{ "total": 0, "limit": 20, "offset": 0, "jobs": [] }`        |
| GET    | `/generations/:id`               | read     | Own job ID in path                                                  | 200 job state, progress, chat reference, output/error             |
| POST   | `/generations/:id/cancel`        | generate | Own job ID; no body                                                 | 200 updated job JSON                                              |
| POST   | `/generations/:id/retry`         | generate | Own job ID; no body                                                 | 200 job JSON; only allowed before possible submission             |
| POST   | `/generations/:id/recover`       | generate | Own job ID; no body                                                 | 200 job JSON; downloads an existing response without a new prompt |
| GET    | `/generations/:id/image`         | read     | Completed own job ID                                                | 200 original image bytes, actual MIME type, attachment filename   |
| GET    | `/generations/:id/metadata`      | read     | Completed own job ID                                                | 200 output metadata JSON                                          |

There is no v1 Google-credential, reference-image upload, arbitrary-navigation,
JavaScript execution, profile export or job-deletion endpoint. `/chats` lists
tracked conversations; new chats are created through generation with `chatId:null`.
The API never guarantees Gemini will return an image.

### Postman workflow: open browser → generate → retrieve output

**1. Test access:** `GET {{baseUrl}}/health`.

**2. Open Gemini:** `POST {{baseUrl}}/browser/gemini` with no body. Sign in directly
in Chrome on the host PC if needed, including MFA. The API does not collect Google
passwords or automate sign-in. A running browser alone does not prove sign-in.
If the dashboard sign-in flow is active, finish it with **Check again** or cancel
it there before submitting API jobs.

`GET {{baseUrl}}/browser/status` returns a state shaped like this illustrative
example (platform, mode/status and message reflect the host; fields may include
additional browser details):

```json
{
  "running": true,
  "platform": "darwin",
  "mode": "native",
  "automation": true,
  "backgroundInput": false,
  "width": 1280,
  "height": 900,
  "frameReady": false,
  "message": "",
  "uploadReady": true,
  "queueBusy": false
}
```

No browser preview is streamed. `frameReady` is a legacy capture-state field, not
Google authentication status. Use the actual Chrome window for manual interaction.

**3. Submit an image request:** `POST {{baseUrl}}/generations`.

Headers:

```text
Content-Type: application/json
Idempotency-Key: postman-image-0001
```

Postman → Body → raw → JSON:

```json
{
  "prompt": "A watercolor mountain landscape at sunrise",
  "chatId": null
}
```

Prompt length is 1–8000 characters. `chatId:null` creates a new chat. To resume,
use a `chatId` from this client's `GET {{baseUrl}}/chats` response. Idempotency keys
are 8–128 letters/digits/underscores/dashes. Keep the same key when retrying the
same HTTP submission after a network error; use a new key for each intentional
new job. Reusing a key for different prompt/chat input fails rather than creating
a duplicate. Different clients have independent key namespaces.

The **202 response is a job, not the generated image**. This illustrative excerpt
shows the key fields; real responses include additional fields/timestamps:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "state": "queued",
  "prompt": "A watercolor mountain landscape at sunrise",
  "chatId": null,
  "chatUrl": null,
  "progress": 0,
  "attempts": 0,
  "submissionPossible": false,
  "canRecoverDownload": false,
  "queuePosition": 1
}
```

Save `id` as a Postman collection variable named `jobId`. Optionally add this to
the generation request's post-response script:

```js
if (pm.response.code === 202) {
  pm.collectionVariables.set("jobId", pm.response.json().id);
}
```

**4. Poll progress:** `GET {{baseUrl}}/generations/{{jobId}}` every few seconds.
The real Gemini `chatId` and `chatUrl` appear after its conversation is observed.
Progress is a stage indicator, not a prediction of time remaining.

| State                                                                           | Meaning / next action                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `queued`                                                                        | Waiting in the global FIFO queue                                                         |
| `running`, `preparing_prompt`, `submitting_prompt`, `generating`, `downloading` | Work in progress; continue polling                                                       |
| `completed`                                                                     | Original image and metadata endpoints are ready                                          |
| `needs_login`                                                                   | Sign in manually on the host, then use safe retry if eligible                            |
| `needs_review`                                                                  | Inspect the saved chat; do not automatically resubmit                                    |
| `failed`                                                                        | Read `error.code`/`error.message`; a text-only response is a failure to produce an image |
| `cancelled`                                                                     | Work stopped; any prompt already submitted remains in Gemini                             |

**5. Download output:** once `state` is `completed`:

```text
GET {{baseUrl}}/generations/{{jobId}}/image
GET {{baseUrl}}/generations/{{jobId}}/metadata
```

Use Postman's **Send and Download** / response save action for the image. It is a
binary PNG/JPEG/WebP response, not base64, a screenshot or an image URL inside JSON.
Use its actual Content-Type/attachment extension when naming the local file.
Requesting either output before completion returns 409.

A completed job has an `output` object shaped like this **illustrative excerpt**;
the example dimensions/bytes are not a live generation result:

```json
{
  "state": "completed",
  "progress": 100,
  "chatId": "example-chat-id",
  "chatUrl": "https://gemini.google.com/app/example-chat-id",
  "output": {
    "filename": "image.png",
    "format": "png",
    "contentType": "image/png",
    "width": 1024,
    "height": 1024,
    "bytes": 184320,
    "checksum": "<SHA-256 of the original image bytes>"
  },
  "error": null
}
```

`output.filename` is a stored filename, not a public URL. Build the image endpoint
from the job ID. The separate metadata JSON contains `jobId`, `chatId`, `chatUrl`,
opaque `accountRef`, `prompt`, the actual prefixed `submittedPrompt`,
`inputAssetNames` (currently empty), `outputFilename`, the image properties above,
`createdAt`/`startedAt`/`completedAt` ISO timestamps and `selectionRule`. Dimensions,
format, bytes and checksum come from the original downloaded file; no image-content
analysis or bounding boxes are produced. Exactly one current-response image is
selected, even when Gemini returns several.

**6. Control or recover a job:** send a bodyless POST to one of:

```text
{{baseUrl}}/generations/{{jobId}}/cancel
{{baseUrl}}/generations/{{jobId}}/retry
{{baseUrl}}/generations/{{jobId}}/recover
```

Cancel cannot undo a prompt already submitted. Retry is rejected if submission
could have occurred. For download failures, use `/recover` when
`canRecoverDownload:true`; it verifies the saved account/chat and image association,
then retries only the download. Ambiguous matches stop for review. Keep the
original failed job; do not delete it or submit a new generation to recover a file.

If automatic recovery still fails, manually download the original from the saved
Gemini chat, then choose **Attach downloaded image** on that dashboard job. Confirm
its association with the displayed job/chat. The app accepts complete PNG/JPEG/WebP
bytes up to 100 MB, including extensionless UUID files. It marks the output as
manual (`output.source=manual_import`, metadata `associationVerified=false`) and
makes it available through the existing image/metadata endpoints without another
prompt. This is user-confirmed provenance, not automatic Gemini association.

### List conversations and continue a chat

Send `GET {{baseUrl}}/chats`. An illustrative response (timestamp placeholders
represent actual ISO timestamps in a real response) is:

```json
{
  "chats": [
    {
      "id": "example-chat-id",
      "url": "https://gemini.google.com/app/example-chat-id",
      "title": "A watercolor mountain landscape at sunrise",
      "createdAt": "<ISO creation timestamp>",
      "updatedAt": "<ISO update timestamp>"
    }
  ]
}
```

To continue that conversation, POST `/generations` with a new Idempotency-Key and:

```json
{
  "prompt": "Now create an image of the same landscape at night",
  "chatId": "example-chat-id"
}
```

Only a real chat ID returned for this API client is accepted; the example ID is
not a usable conversation. List jobs with `GET {{baseUrl}}/generations?limit=20&offset=0`;
responses contain `total`, `limit`, `offset` and the full `jobs` array in newest-first
order. Increase `offset` for the next page. A client with no tracked chats/jobs gets
an empty array, not another client's data. Browser start/stop and cancel/retry/recover
requests need no JSON body; their JSON response reflects the resulting browser or
job state, and an asynchronous queued operation must still be polled.

### curl examples

Set `IMAGE_API_TOKEN` locally from your issued secret. For LAN HTTPS, point
`LAN_CA_FILE` at the exported CA on the calling PC; Postman's CA import does not
configure curl. These examples use a placeholder LAN address—use the printed URL.

```sh
export IMAGE_API_BASE="https://192.168.1.50:3443/api/v1"
export LAN_CA_FILE="/path/to/Studio-LAN-CA.crt"

curl --fail-with-body --cacert "$LAN_CA_FILE" \
  "$IMAGE_API_BASE/health" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

curl --fail-with-body --cacert "$LAN_CA_FILE" -X POST \
  "$IMAGE_API_BASE/browser/gemini" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

curl --fail-with-body --cacert "$LAN_CA_FILE" -X POST \
  "$IMAGE_API_BASE/generations" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: curl-image-0001" \
  --data '{"prompt":"A watercolor mountain landscape at sunrise","chatId":null}'

# Replace JOB_ID with the returned job ID; poll until completed.
curl --fail-with-body --cacert "$LAN_CA_FILE" \
  "$IMAGE_API_BASE/generations/JOB_ID" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN"

# Example for an output whose actual format is PNG:
curl --fail-with-body --cacert "$LAN_CA_FILE" \
  "$IMAGE_API_BASE/generations/JOB_ID/image" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" --output generated-image.png

curl --fail-with-body --cacert "$LAN_CA_FILE" \
  "$IMAGE_API_BASE/generations/JOB_ID/metadata" \
  -H "Authorization: Bearer $IMAGE_API_TOKEN" --output metadata.json
```

For a public hostname with a publicly trusted certificate, omit `--cacert`.
For local loopback HTTP, use `http://127.0.0.1:3030/api/v1` and omit it. Do not use
plaintext HTTP on the LAN or disable TLS verification.

### API errors, limits and troubleshooting

| HTTP status | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| 200         | Status/list/output/control request succeeded                           |
| 202         | Generation accepted; poll its job ID                                   |
| 400         | Invalid input, unsafe retry/recovery or other sanitized action failure |
| 401         | Missing, invalid, expired or revoked bearer token                      |
| 403         | Missing scope, unexpected Host/Origin or HTTPS transport required      |
| 404         | Unknown endpoint/job or another client's job/chat                      |
| 409         | Output not ready, browser busy or manual sign-in flow active           |
| 429         | Rate limit; respect `Retry-After`                                      |

HTTP failures use `{ "error": "message" }`, sometimes with `code`; for example:

```json
{
  "error": "Output is not completed",
  "state": "generating"
}
```

A job's generation failure is different: a successful **GET job** can return 200
with `state:"needs_review"` and `error:{ "code", "message" }`. Check both HTTP
status and job state. `/health` checks service access, not Google authentication
or whether Gemini will generate an image.

Limits: 120 requests/minute per client, 600 admissions/minute per source IP,
50 pending jobs, 500 retained jobs, 100 MB per output image, and a default 180-second
job timeout (`GENERATION_TIMEOUT_SECONDS`, maximum 900). API list pagination uses
`limit`/`offset`. JSON bodies are limited to 64 KB. A downloaded image alone does
not make the job completed until the app validates and saves its metadata.

- Certificate errors: import the host's public CA in Postman; keep verification on.
- Host/HTTPS errors: use the exact printed base URL, including HTTPS and port.
- 403 scope error: issue a token with the required scopes. Dashboard credentials
  are not bearer tokens.
- `needs_login`: sign in in the host's actual Chrome window; never send Google
  credentials in an API body.
- Download failure: use eligible download-only recovery. The debug console tracks
  download click, start, file-ready and verified-output events.

## Dashboard-only endpoint list

These endpoints support the web dashboard. Prefer **`/api/v1` above** for Postman
and integrations. A v1 bearer token does not authenticate these routes. The dashboard is open by default, including LAN mode; everyone who reaches it
can access the shared workspace. Explicit `AUTH_REQUIRED=true` outside LAN mode
enables the optional administrator session.

First call `GET /api/session` and retain its cookie. Every dashboard mutation
(including login) needs the exact configured `Origin` and the returned
`X-CSRF-Token`. In protected mode, POST `/api/login` with username/password using
that cookie/CSRF, then use the new CSRF token returned after login. Never send
Google credentials to this login; it is for the app administrator only.

| Method | Full endpoint                        | Input / output                                                                                                           |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/session`                       | Session/CSRF token and auth/configured status                                                                            |
| POST   | `/api/login`                         | JSON `username,password`; returns renewed `csrf,username` and session cookie                                             |
| POST   | `/api/logout`                        | Ends session, stops browser; returns `{ "ok": true }`                                                                    |
| GET    | `/api/health`                        | `{ "ok": true, "browser": boolean }`                                                                                     |
| GET    | `/api/state`                         | Browser state                                                                                                            |
| POST   | `/api/action`                        | Browser action JSON, e.g. `{ "type": "start" }`; returns browser state                                                   |
| GET    | `/api/gemini-flow`                   | Manual sign-in flow state, activity and step history                                                                     |
| POST   | `/api/gemini-flow`                   | JSON `command:"start"`, or `command:"proceed"/"cancel"` with flow `id`; returns flow state; credential input is rejected |
| GET    | `/api/automation/settings`           | Server-side Groq configuration status/usage; never returns the key                                                       |
| POST   | `/api/automation/settings`           | JSON `model,key`; saves private settings and returns status                                                              |
| GET    | `/api/generation`                    | Job summaries, active/queue status and saved chats                                                                       |
| POST   | `/api/generation/jobs`               | JSON `prompt,chatId,idempotencyKey`; 202 job JSON                                                                        |
| GET    | `/api/generation/jobs/:id`           | Job JSON                                                                                                                 |
| POST   | `/api/generation/jobs/:id/cancel`    | Updated job; cannot undo a submitted prompt                                                                              |
| POST   | `/api/generation/jobs/:id/retry`     | Safe pre-submission retry; updated job                                                                                   |
| POST   | `/api/generation/jobs/:id/recover`   | Download-only recovery; updated job                                                                                      |
| POST   | `/api/generation/jobs/:id/import`    | Multipart `file` (up to 100 MB) and `confirmed=true`; user-confirmed manual output attachment; returns completed job     |
| DELETE | `/api/generation/jobs/:id`           | Remove terminal local job/output; Google chat retained                                                                   |
| PATCH  | `/api/generation/chats/:id`          | JSON `title` (1–100 chars); local rename                                                                                 |
| GET    | `/api/generation/jobs/:id/image`     | Inline original image; add `?download=1` for attachment                                                                  |
| GET    | `/api/generation/jobs/:id/metadata`  | Metadata JSON attachment                                                                                                 |
| POST   | `/api/upload`                        | Multipart `file`, maximum 20 MB; requires an open native file picker; `{ "ok": true }`                                   |
| GET    | `/api/downloads`                     | Browser download array with `id,name,bytes,created`                                                                      |
| GET    | `/api/downloads/:id`                 | Browser file attachment                                                                                                  |
| DELETE | `/api/downloads/:id`                 | Delete that local browser download                                                                                       |
| GET    | `/api/logs?level=error&after=CURSOR` | Sanitized journal; optional level (`info,warn,error`) and replay cursor                                                  |
| GET    | `/api/logs/export`                   | Sanitized log JSON attachment                                                                                            |
| DELETE | `/api/logs`                          | Clear journal; returns current snapshot                                                                                  |

The same-origin, session-protected **WebSocket `/stream`** sends browser state,
sanitized logs, manual sign-in steps and generation snapshots. It does not stream
browser preview images and is not a bearer-token v1 WebSocket endpoint. Normal API
clients poll job/status endpoints instead. See [dashboard API details](docs/api.md).
