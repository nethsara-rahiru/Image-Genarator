# Local Gemini Image Generator

Run a local image-generation dashboard and a dedicated Chrome/Edge browser on
your PC. Enter a description, create or resume a Gemini chat, and download one
original generated image with its actual chat ID and metadata. The local app
opens without an administrator login. Google sign-in is separate and still
required; Google may reject automated browsers or decline to generate an image.

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
`PUBLIC_ORIGIN=http://127.0.0.1:3030`; public origins are rejected in no-login mode.

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

## Groq recovery and browser controls

The existing sign-in assistant offers **Groq recovery settings**. Enter its API
key there, never in chat, and a JSON-capable model identifier. The key stays in
private server `groq.json`; API responses never return it. Native mode can also
use `GROQ_API_KEY`/`GROQ_MODEL`. Background mode uses dashboard configuration.
Groq receives only sanitized navigation candidate IDs/categories, never passwords,
codes, cookies, account names, raw page text or login screenshots. Unknown sign-in
steps use at most two bounded recovery requests; unsafe/unsupported steps hand
off to the user. Generation uses guarded deterministic controls and pauses when
its prompt/response/download UI cannot be verified.

The manual browser provides Google search, native tabs, keyboard/mouse, text
entry, upload through a native file chooser (20 MB), downloads and a private
sanitized debug console. Native navigation opens a new Chrome tab; the viewer's
address field is not an extracted current URL. Audio, drag-and-drop and control
of unrelated applications are not provided. Use the actual Chrome controls when
native popups require manual interaction.

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
real user data. **No-login access is local/shared**: anyone with access to this
PC or its trusted SSH tunnel can control the saved browser and read the workspace.
The service binds to 127.0.0.1; use encrypted SSH forwarding from another device.
Public anonymous access is not implemented.

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

## Public HTTPS API

Use the versioned bearer-token API to start Chrome, open Gemini, generate images,
track jobs and download outputs from another application. Create scoped, expiring
client keys with `npm run api-client -- create "my-backend" read,generate,browser 90`.
Public access requires `AUTH_REQUIRED=true`, a configured HTTPS origin and a valid
TLS reverse proxy. Google sign-in stays manual on the host; clients share its
browser/session and global queue. See [client API guide](docs/client-api.md) for
HTTPS deployment, token revocation, endpoints and curl examples.
