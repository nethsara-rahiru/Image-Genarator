# Local PC setup and remote access

## Local startup

Install Node.js 22+ and desktop Google Chrome (Edge fallback supported). Clone/download the reviewed main source. In a terminal in the project directory: npm ci, then node app.js. Startup detects the OS and prompts to create the admin if no identity exists and stdin is interactive. It opens the configured viewer URL. Later only node app.js is needed. Explicit CLI bootstrap/reset remain available. For service/noninteractive startup provision the administrator first.

Do not reuse the former VPS .env blindly. For local access the defaults need no .env: PORT=3030, PUBLIC_ORIGIN=http://127.0.0.1:3030, DATA_DIR=./runtime. Optional CHROME_PATH selects an installed executable; AUTO_OPEN=false disables opening a viewer. A stable DATA_DIR and project working directory are important for profile/admin continuity.

Windows automatically selects installed Chrome or Edge in common Program Files/LocalAppData paths. Use an unlocked interactive user session. The bundled PowerShell script must be permitted by your local/organization policy; verify the source before approving/unblocking it. Do not run as administrator or bypass an organization policy. Capture can depend on Windows/DWM/GPU behavior and requires target validation.

macOS automatically selects Chrome/Edge under /Applications. For another install set CHROME_PATH. Grant terminal/Node Screen Recording, Accessibility and Automation permissions locally. Keep the window visible/unminimized. These prompts cannot be auto-approved. System Events/Unicode input and GPU/capture compatibility need real-device acceptance.

Debian/Ubuntu: npm run setup-host installs missing Xvfb/xauth/xdotool/Openbox/ImageMagick/xprop prerequisites through your terminal's sudo prompt. Install desktop Chrome separately if missing. Other Linux distributions show the required packages. A convenience scripts/install-ubuntu.sh performs npm ci and package installation. Production must run as non-root with sandbox/user-namespace support. An Ubuntu AppArmor exception may still be needed for an explicitly selected downloaded Chrome build; official packaged Chrome normally provides its supported sandbox integration. Never disable sandboxing globally to make the app run.

## From a second device using SSH

If your PC already has an SSH server configured, run on the viewing device:

```bash
ssh -N -L 3030:127.0.0.1:3030 your-user@your-pc
```

Then browse http://127.0.0.1:3030 on that device. The host must keep PUBLIC_ORIGIN=http://127.0.0.1:3030. This works with Windows OpenSSH, macOS Remote Login or Linux SSH after the OS user deliberately enables it. Do not open Node or native-control ports publicly.

## Optional: keep the VPS HTTPS address as a gateway

Chrome and the Node app run on the local PC; only the encrypted viewer is forwarded through the VPS. On the PC configure:

```dotenv
PORT=3030
PUBLIC_ORIGIN=https://162.35.181.135:3443
AUTO_OPEN=false
```

Start this reverse tunnel from the PC in a separate terminal:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:3031:127.0.0.1:3030 dev@162.35.181.135
```

On the VPS, stop the previous vps-browser PM2 app to avoid using the old host, and change Caddy's upstream to 127.0.0.1:3031:

```caddyfile
{
    auto_https disable_redirects
}
162.35.181.135:3443 {
    tls internal
    reverse_proxy 127.0.0.1:3031 {
        flush_interval -1
    }
}
```

Validate/reload Caddy after reviewing the change. Start node app.js on the PC and visit the trusted HTTPS VPS address. Both the PC app and SSH tunnel must remain running and the PC awake. Only loopback reverse forwarding is used; don't enable public GatewayPorts. SSH credentials/keys stay in the SSH client and are never collected by this application. A private Caddy CA must be verified/trusted on the viewing device; never copy its private key or disable TLS verification. This gateway workflow has not been exercised against the user's VPS.

## Updates and optional background use

Close the managed browser and stop the app before updating: fetch main, git pull --ff-only, npm ci, node app.js. Do not force-reset unrelated local changes or overwrite runtime/.env. The default is interactive local use. Optional PM2 configuration remains for a logged-in user, but a background/system service cannot gain Windows/macOS desktop capture permissions or an interactive desktop automatically. Prefer a terminal or per-user login task on those systems. Keep one instance per DATA_DIR.

## Backup, restore and troubleshooting

Stop the app and managed Chrome before privately archiving DATA_DIR and .env. Profiles contain authenticated sessions; encrypt backups and restrict access. Restore ownership/permissions/Windows ACLs before startup. The old Playwright profile remains untouched under runtime/profile; new Chrome uses runtime/native-profile and does not import it. A new PC still needs a Chrome install and its own OS permissions. Backups and real Google session restoration remain unverified.

- Wrong admin: npm run reset-admin in this project using the same DATA_DIR; sessions are revoked.
- Missing Chrome: install desktop Chrome/Edge or set CHROME_PATH. No production Playwright browser install is required.
- Missing Linux tools: npm run setup-host; inspect terminal errors if an administrator is needed.
- Capture/input failure: npm run doctor, then Debug console. Unlock the PC, restore the Chrome window and grant OS permissions locally. There is no full-screen fallback.
- Orphan/profile busy: close the previous dedicated Chrome window/process, not your unrelated personal browser. The private native/browser.json identifies the previous managed PID. Do not delete live Chromium/lockfile locks or force-open a profile already in use. A crashed host may require closing that recorded Chrome process before restart.
- Upload: click the website's native file picker first, then the viewer's Upload file. An unsupported native chooser is rejected rather than typing a path into the website. Try manual interaction with the chooser inside the stream.
- Download: inspect Chrome's own download UI for security prompts. Hidden/incomplete/>100 MB files are not listed. Use host disk quotas for hard limits.
- Remote connection: check the configured PUBLIC_ORIGIN, tunnel, TLS trust and WebSocket proxy. The app always binds to localhost.
- Google restriction: use the site's supported verification flow. Native/local execution improves some signals; it is not a guarantee or a bypass.

## macOS diagnostic details

A Chrome window can open while viewing/control remains unavailable. Run npm run doctor from the same terminal and project directory while the managed Chrome window is open. It reports read-only Screen Recording/Accessibility preflight status, CoreGraphics window-query status and the count of visible windows belonging to the recorded managed process. It never prints window titles, Google credentials or page contents. Automation denial is identified when an actual System Events control request is attempted; the read-only check does not trigger it.

- MAC_AUTOMATION_REQUIRED: Privacy & Security → Automation, allow the launching terminal/app to control System Events.
- MAC_ACCESSIBILITY_REQUIRED: enable the launching terminal/app under Accessibility.
- MAC_SCREEN_RECORDING_REQUIRED: enable Screen Recording or Screen & System Audio Recording; restart the terminal if macOS requests it.
- WINDOW_NOT_READY: restore the managed Chrome window and put it on the current desktop/Space. This code is not a permission diagnosis.
- MAC_WINDOW_QUERY_FAILED / MAC_NATIVE_FAILED: a bridge/helper operation failed. Share doctor output and the safe helper stage; repeatedly toggling permissions may not solve this.

Stop Node with Ctrl+C before restarting the terminal. Do not delete the native profile or reset macOS TCC permissions globally. Google sign-in can be opened from its new button without desktop-control permission, or manually at https://accounts.google.com/ in the already opened Chrome. Complete password/MFA there; retain the profile for session reuse.

## Local PC background workspace

Install/start Docker Desktop with Linux containers on macOS/Windows (or a local
Docker engine on Linux). Stop any native app on the chosen port, update source,
run `npm ci`, then `node app.js --background`. The launcher prompts for a separate
background administrator, builds the image, and serves the dashboard at
http://127.0.0.1:3030 by default. It preserves its profile under
`DATA_DIR/background`. Select Start Gemini sign-in and follow the live steps.
Keep Docker/Node running and the PC awake. Ctrl+C stops only this launch's
container; restarting resumes its saved profile where the website allows.
Use `node --env-file-if-exists=.env scripts/background-admin.js` to reset the
background admin after stopping it. Native `reset-admin` changes native mode only.

If a crash leaves a container running, inspect `docker ps` for the
`local-browser-...` container with label `local-native-browser.background=true`,
verify its mounts identify this workspace, and use `docker stop <container-id>`.
Do not delete profiles or unrelated containers. The launcher refuses a name or
profile conflict. Kernel user-namespace restrictions can block sandbox startup;
inspect `BROWSER_SANDBOX` diagnostics without disabling sandboxing. Physical
Docker Desktop and live Google sign-in acceptance are still required.

## Gemini-first flow and Groq configuration

Start the app and select Start Gemini automation. It opens Gemini before any
credential request and stops when signed-in UI is observed. If signed out, enter
the requested email/username/password/code in the dialog. Inputs are used once
on verified Google fields, not stored, and never sent to Groq. Complete passkeys,
CAPTCHA, phone approval and other security steps in the actual live browser, then
choose Check again. Inspect ambiguous results before any manual retry.

Groq recovery settings accepts a server-side API key and JSON-capable model ID.
Native mode can use GROQ_API_KEY/GROQ_MODEL; background mode should configure the
key through the dashboard (host secrets are not automatically forwarded).
Backups containing groq.json are sensitive. Groq is only used for unknown safe
navigation steps, never login screenshots or credentials. If unconfigured or
unavailable, the flow hands control to the user. Observe usage/errors in settings
and the debug console. Real service acceptance needs target validation.
