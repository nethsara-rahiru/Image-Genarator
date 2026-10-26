# Local browser mode

The VPS remains the authenticated dashboard, durable Mongo queue, event stream, Groq recovery service and output store. A local Node companion runs jobs in a Chrome/Edge profile that the user signs into normally. Google credentials, cookies, browser profiles and login screens are never copied to the VPS. The extension uses a dedicated Gemini tab in the user's normal browser; it does not launch Chromium with automation flags or expose a debugging port.

Local mode changes the original VPS-only browser architecture. It does not bypass Google's security checks or guarantee image generation. Stop if Google rejects authentication or restricts a job. Live Google behavior, Windows and macOS execution still need target-device validation; automated tests run on Linux with controlled Gemini-like pages.

## Upgrade the VPS

With generation idle, fetch the reviewed local-companion feature branch/commit. The branch includes the earlier viewer lifecycle repair and is stacked on that PR. Install the server's locked dependencies with `npm ci` if needed. In the protected server `.env` set:

```dotenv
EXECUTION_MODE=local
HOST=127.0.0.1
# Keep your existing API port (3030 on the current VPS) and HTTPS origin.
PORT=3030
PUBLIC_ORIGIN=https://162.35.181.135:3443
```

Keep your Atlas URI, session secret and Groq key server-side. Restart both PM2 processes with `pm2 restart ecosystem.config.cjs --update-env`, preserving the configured public origin. `pm2 save`. In local mode the VPS worker does housekeeping/recovery and does not launch Playwright or hold the global generation lease while idle. The local protocol uses the same global Mongo lease as the original worker; a stale/misconfigured native worker safely blocks local claims until it is stopped/reconfigured. Do not remove live locks manually. Existing accounts/chats/jobs/outputs remain in the database; bind each account to a local profile before generating local jobs. Cancel queued jobs before changing an account's binding.

## One-time setup on any supported PC

Requirements: Node.js 22+, a current desktop Google Chrome or Microsoft Edge, a writable Downloads folder and access to the trusted HTTPS VPS. Do not run the companion as administrator/root. Chrome/Edge unpacked extension installation requires Developer mode once; managed corporate browsers may prohibit it. Firefox and Safari are not supported by this extension. The computer must stay awake, online, and keep the companion terminal and extension tab open.

1. Sign into the VPS dashboard → **Local devices**. Click **Download the local companion ZIP**, extract the entire archive to a permanent folder. The ZIP includes a minimal package.json, app.js, companion/ and extension/. It contains no Mongo credentials, .env, private keys or browser data.
2. In a terminal opened in that extracted folder, run:

   ```bash
   node app.js
   ```

   No `npm install`, MongoDB, PM2, Playwright, Docker or Linux flock is required on the PC. The app opens `http://127.0.0.1:4317`. It listens only on loopback and requires a local request token and exact host/origin for changes. If browser auto-open is unavailable, use the printed URL. `COMPANION_PORT` and `COMPANION_HOME` are optional environment overrides; use one companion process per PC/configuration.

3. In the VPS dashboard → Local devices, create a one-time pairing code for this computer. In the local page, enter the VPS HTTPS origin and that code. Pairing codes expire in ten minutes and can be used once. The device receives a narrow token, stored under your home directory in `.gemini-agent-companion/config.json` with restrictive permissions where supported. Do not share that file. Devices expire after 90 days and can be revoked in the dashboard; re-pair and rebind if expired.
4. If the VPS uses Caddy's private CA, choose its **public root.crt** in the local page. Copy it over your authenticated SSH connection and compare its SHA-256 fingerprint with the server. The companion shows the fingerprint. Browser trust alone does not necessarily establish Node trust, so supply the CA here as well. TLS verification and IP/hostname validation remain enabled. Publicly trusted server certificates need no extra file. Never provide a private CA key, Google password or server .env.
5. In Chrome open `chrome://extensions` (Edge: `edge://extensions`), enable Developer mode, **Load unpacked**, and select the extracted **extension/** folder. Click the extension icon to open its **Local browser companion** tab.
6. On the local Node page choose **Create extension pairing code**. In the extension tab enter the local companion URL, a label for this browser profile, and that extension code. Leave the extension tab open. This is a separate one-time pairing from the VPS code. Chrome's ordinary user session stays in this browser profile; the extension has no cookies, history or debugger permission.
7. On the VPS Local devices page, click **Refresh devices** and bind a Google account entry to this computer/profile. Confirm the identity manually. A profile can bind to only one account. For multiple Google accounts, create separate normal Chrome/Edge profiles and load/pair the extension in each profile; they can share the same local Node companion.
8. Accounts → **Connect / reconnect** opens the dedicated Gemini tab on the paired PC. Sign in directly to Google there, including normal MFA/security checks. Accounts → **Verify & finish** requests an asynchronous visible-UI check; the account becomes ready after the extension responds. The profile's Google identity must match the account label; the app cannot cryptographically prove identity from UI alone. A failed check leaves the browser available for normal manual login.
9. Confirm the local page's Chrome Downloads folder matches browser Settings → Downloads. Use the default Downloads folder when possible. Turn off **Ask where to save each file** for automatic capture; a save dialog, browser download block, policy restriction or custom path can prevent output capture. The app reads only a completed file directly inside this explicitly configured directory, with the current run's randomized filename prefix; traversal and symlink escapes are rejected.
10. Use Generator, saved Chats, Jobs and Outputs as before. The local browser receives only its assigned account's job and reference files, uses the current response's download action, selects the first valid image in DOM order, and uploads exactly one original. The VPS derives actual image dimensions/format/bytes/checksum and writes the JSON metadata. Locally downloaded originals remain in your Downloads folder until you remove them. Monitoring shows only a preview derived from the verified output, never login/account screenshots.

For later runs: **`node app.js`** and use the VPS dashboard. In a paired Chrome/Edge profile, opening the local setup page automatically reopens the extension companion tab. It also reconnects when that browser profile starts. Keep that tab open; if your default browser is not the paired Chrome/Edge profile, open the printed local URL in the paired profile or click its extension icon. Pairing persists; Google session reuse depends on Google and your normal browser settings. Starting the Node program cannot create a Chrome/Edge profile or install an extension silently; that initial user-controlled setup remains explicit.

## Reliability and safety

The queue is globally FIFO. An offline device/profile at its head blocks later jobs until it returns, the account is verified or the administrator cancels that job. Multiple online PCs cannot claim concurrent generation jobs. References and outputs are scoped to the owning device, run ID and lease fence. Sessions/keys are not transferred between PCs.

The server persists a single-use submission boundary and a durable global barrier **before** issuing a short-lived send permit. The extension cannot submit without that acknowledgement and never repeats a send for the same run. The companion stops new actions when its server heartbeat becomes stale or the extension disconnects. A running Gemini request may continue on Google's servers after disconnection; its existence cannot be fenced by a local lease. The queue therefore remains blocked after an ambiguous submitted run, even when its lease expires. It is marked `needs_review`; there is no automatic resubmission or automatic takeover. The administrator must inspect the old browser/conversation, stop the old companion if necessary, confirm Google generation has finished, and choose **Review & release queue** before another job can run. A retry is then an explicit, bounded administrator action. Saved outputs are reconciled without resubmitting a prompt after a crash.

The browser extension tab uses a local authenticated event stream, so background timer throttling is not its only source of work. Closing/discarding the tab, quitting Chrome, sleeping the computer or losing network access can still interrupt a run. This becomes an actionable state, not a promise of uninterrupted execution. It never copies a Google session to another machine. Chrome may enforce download/automation/enterprise policies; those restrictions are surfaced and not bypassed.

Local browser actions are fixed commands against Gemini app/conversation URLs. The generation content script runs only on https://gemini.google.com, never on Google password/MFA pages. A separate launcher script recognizes the loopback setup page and reopens the paired extension tab; it does not handle Google pages. Groq receives bounded sanitized control metadata only, with a durable three-call per-job budget; no JavaScript, arbitrary URLs, cookies, prompts, credentials, reference images or login screenshots are accepted as model actions. Native Google authentication remains under the user's control. Pair only a VPS you administer and trust to issue generation requests.

## Troubleshooting

- **Not paired / device revoked:** create a new VPS pairing code and pair the computer again, then rebind accounts to the new device entry.
- **Certificate error:** import the correct public CA certificate into the companion and verify its fingerprint over SSH; use the exact HTTPS IP/domain/port in PUBLIC_ORIGIN. Never disable certificate verification.
- **Browser offline:** keep the extension companion tab open in the correct Chrome/Edge profile; click Reconnect. The local page should show the profile online. Restarting the extension tab during an active run requires review.
- **Needs login:** sign in to Google manually in that profile's dedicated Gemini tab, then verify from Accounts. If Google rejects the browser, stop and follow Google's supported sign-in guidance.
- **Queue waiting for FIFO device:** bring the first queued job's paired PC/profile online or cancel the queued job.
- **Local mode disabled:** set EXECUTION_MODE=local and restart both server processes. Do not run a native worker from a separate configuration against the same queue.
- **Download failed:** check the browser's own Downloads page, save prompts, completed filename and configured directory. Unrelated downloads, partial files, unsupported images and mismatched paths are rejected. Preserve uncertain output locally for manual review.
- **Selectors changed / upload not confirmed:** the adapter prefers verified selectors and deterministic controls, then bounded Groq recovery. It fails safely if Gemini's current DOM cannot be verified. Do not repeatedly retry an uncertain submission.
- **Remove local installation:** stop the terminal with Ctrl+C, revoke the computer on the VPS, remove the unpacked extension and the companion folder/configuration. Google login/logout and deletion of the Chrome profile remain browser-user actions; the app does not erase personal browser data.

## Test and release status

Automated Linux fixtures cover loopback host/origin/CSRF isolation, one-time extension/VPS pairings, device scoping, TLS CA validation, blocked redirects, standalone ZIP launch without packages, file signature/dimensions/path checks, FIFO lease exclusion, submission barriers, output upload and crash recovery. A real unpacked extension in Chromium performs a reference upload, fills/submits a prompt, scopes the new response, downloads/renames original images through Chrome's Downloads API, skips an invalid candidate, and uploads the first valid image to the companion's controlled server fixture. Google login/generation is not exercised by that test. The dashboard pairing/binding/ZIP flow uses actual HTTPS API requests in E2E tests. Real Windows/macOS Chrome/Edge, real Google/Groq and the target VPS still require acceptance checks before a production release.
