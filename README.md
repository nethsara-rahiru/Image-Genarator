# Private VPS Browser

A private browser running on your VPS, controlled from your own web browser. Includes password-protected access, persistent website sessions, tabs, navigation, mouse/keyboard control, text paste, file uploads and original downloads. Vanilla HTML/CSS/JavaScript viewer; Node.js 22+, Express and Playwright Chromium on the server. No MongoDB, Groq, Redis, Docker or local extension required.

This is a full replacement for the earlier Gemini automation platform. It does not generate images or run background AI jobs. The old source remains in Git history. Existing MongoDB administrator credentials do not carry over; create the new administrator once.

## Install on the VPS

Run as a dedicated **non-root** user (your `dev` user is suitable). Use a supported Ubuntu release; CI validates the dependency installer on GitHub Ubuntu, not your actual VPS.

```bash
cd ~/Image-Genarator
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
chmod 600 .env
npm run setup-admin
node app.js
```

`node app.js` loads `.env` automatically. Chromium needs its one-time installation above. An alternative dependency installer is `bash scripts/install-ubuntu.sh`. Google credentials are entered only into the remote website, never the app's administrator form.

## Open it securely

Default: the service binds to `127.0.0.1:3030`. From **your PC**, open an SSH tunnel:

```bash
ssh -N -L 3030:127.0.0.1:3030 dev@162.35.181.135
```

Leave the SSH terminal open. On your PC visit **http://127.0.0.1:3030**. The public part of this connection is encrypted by SSH. Keep `PUBLIC_ORIGIN=http://127.0.0.1:3030` in `.env` for this method.

For public IP access at **https://162.35.181.135:3443**, use your existing Caddy TLS proxy and set `PUBLIC_ORIGIN=https://162.35.181.135:3443`. See [deployment](docs/deployment.md). Never expose the Node port or viewer through public plaintext HTTP. A private Caddy CA must be trusted on your own device; don't enter credentials through a certificate warning.

## Use the browser

1. Sign in using the administrator created by `npm run setup-admin`.
2. Click **Start browser**, enter a public website address and press Go.
3. Click the remote screen, then type, scroll or use supported keyboard shortcuts. **Type / paste text** also works on mobile.
4. Use the tab strip to switch/close tabs; ＋ opens another (maximum eight).
5. To upload: click the website's file picker in the remote screen, then click the viewer's **Upload file** button (one file, up to 20 MB).
6. Click a website's download link. Open **Downloads → Save to device** to retrieve the original. Completed files up to 100 MB are retained, newest 100. Delete removes the server copy.
7. **Stop** or **Sign out** closes tabs and saves the profile. Start again and navigate to the site to reuse sessions where allowed. Viewer disconnection does not immediately close Chromium; inactivity stops it after 30 minutes by default.

Google and other sites may reject a VPS/browser sign-in. This project does not bypass MFA, captchas, security restrictions or account blocks. Audio/video streaming, microphone/camera, drag-and-drop, browser extensions, arbitrary native dialogs and full desktop access are not provided. The viewer streams images, so website accessibility is limited. See [security and limitations](docs/security.md).

## Forgotten administrator password

In your VPS terminal, from this project directory:

```bash
npm run reset-admin
```

Enter the existing username or accept the displayed default, then a new password twice. Input is hidden. Existing sessions are invalidated. No database edits and no password pasted into chat are needed.

## Run continuously

After your manual smoke test, install PM2 if needed and run:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the exact privileged startup command PM2 prints. See [deployment](docs/deployment.md) for replacing the former `gemini-api` / `gemini-worker` services without a port conflict, updates and backups.

## Browser startup diagnostics

If Start browser fails, run `npm run doctor` as the **same user** running PM2. It launches an isolated empty profile with sandboxing enabled, never opens a website or reads the saved browsing profile, and reports the actual startup failure. Missing executable/dependencies, root execution, sandbox/AppArmor restrictions, profile locks and permissions now have distinct viewer errors. Never work around a sandbox error by adding `--no-sandbox` or disabling system security globally.

## Verification

```bash
npm run lint
npm test
npm audit --omit=dev --audit-level=high
```

The suite uses real Chromium and controlled local pages, checks authenticated HTTP/WebSocket access, navigation/input, uploads/downloads, persistent profiles and desktop/mobile layout. Test-only private fixture routing and sandbox relaxation are not enabled in production. No test signs into Google. See [test report](docs/test-report.md).
