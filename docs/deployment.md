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
