# Local Native Browser

Run a regular desktop Chrome/Edge window on your own PC and control it through an authenticated browser viewer. Node automatically detects Windows, macOS or Linux. Includes Google search, native browser tabs/DevTools, keyboard/mouse/paste controls, file transfers and private debug logs.

Production does **not** use Playwright, headless Chromium, CDP or a browser-automation extension. Windows uses a bundled PowerShell/C# window-only helper. macOS uses built-in JXA and window-only screen capture. Linux runs installed Chrome on a private Xvfb desktop with OS input/capture. Google sees the host PC's outbound network connection. This should improve compatibility over a headless VPS browser, but **does not guarantee Google sign-in**. Google may still request verification or reject access. No security-check bypass or cookie import is implemented.

## First run

Install **Node.js 22+** and ordinary desktop **Google Chrome** (Edge is detected as a fallback). Download/clone this repository into a permanent folder, then open a terminal there:

```bash
npm ci
node app.js
```

The app detects your OS, prompts for a local administrator on first interactive startup, and opens `http://127.0.0.1:3030`. Password entry is hidden and confirmed. For subsequent runs: **`node app.js`**. No .env is required for local defaults, and no MongoDB, VPS, Docker or local extension is required.

Click **Start browser**. Sign into Google directly in the dedicated Chrome window, including normal verification. Credentials/cookies stay on this PC. A new dedicated profile is used; it does not import your personal Chrome profile or earlier Playwright sessions.

### OS setup and permissions

- **Windows 10/11:** use an unlocked desktop with the managed Chrome window not minimized. A bundled PowerShell helper captures only that process's window using PrintWindow. Remote input focuses it and can move your mouse; use a separate OS account for uninterrupted work/isolation. PowerShell or enterprise application-control policy may require local approval for the trusted script. Do not disable organizational controls. GPU/window-capture compatibility still needs real-device validation.
- **macOS:** allow the terminal/Node the requested **Screen Recording, Accessibility and Automation** permissions in System Settings. Keep the managed window unminimized. These are OS consent prompts and cannot be silently granted. Capture is limited to a window owned by the managed Chrome PID; a very short-lived private frame file is deleted after capture. Real-device permission/capture/input validation is required.
- **Linux:** run `npm run setup-host` once to detect/install Xvfb, xauth, xdotool, Openbox, ImageMagick, xprop and D-Bus on Debian/Ubuntu (sudo may ask in your terminal). Install desktop Chrome if missing. Other distributions show the package names for their package manager. Chrome runs on an authenticated private display, not your working desktop. X11 TCP is disabled; no VNC/debug port is exposed. Run the app as a non-root user with Chromium sandbox support. Host AppArmor restrictions may still require configuration.

You don't need to select an OS. If Chrome is installed somewhere unusual, set `CHROME_PATH` in .env. `npm run doctor` checks executable/helper availability without opening your personal profile or taking a screenshot. `npm run doctor -- --launch` additionally tests a fresh blank native window and capture, discards its frame, and removes its temporary profile. `AUTO_OPEN=false` disables opening the viewer automatically.

## Google account sign-in

Click **Google sign-in** after starting Chrome. It requests Google's official account chooser in the existing dedicated Chrome profile using the browser's normal URL-opening mechanism. This action doesn't require screen capture, Accessibility or a simulated key sequence, so you can continue directly in the opened Chrome window while resolving viewer permissions.

Enter your Google email/password and complete MFA or security checks **directly in Chrome**. The app doesn't collect Google credentials or silently complete verification. For another account, use Google's account chooser/Add another account. The local native-profile retains sessions where Google permits; closing/restarting the app doesn't intentionally sign out Google. Google can expire/reject sessions or require reauthentication. No live Google login has been validated in automated tests.

## Browser controls

The actual Chrome tab strip, address bar, menus and website appear inside the streamed window. Use those directly, or the viewer's Google/search, Back/Forward, Reload, New tab and Close tab controls. The viewer address field opens a URL/search in a new tab through Chrome's normal URL-opening mechanism; it is not an extracted live URL. Use Chrome's address bar inside the display to navigate in the current tab. **Chrome console** toggles native Chrome DevTools; **Debug console** shows the app's operational logs. Command completion means OS input was delivered, not that a website finished loading.

Click inside the stream before typing. **Type / paste text** works with mobile and Unicode; some macOS input methods need live acceptance testing. Remote input can steal focus from other work on Windows/macOS. This product shares a dedicated browser window, not your whole host desktop, but an authenticated operator has the normal browser/file-picker privileges of the host OS account. Use a dedicated account if you need stronger isolation.

To upload: open a website's native file picker, then click the viewer's **Upload file** and choose one file up to 20 MB. The helper requires a native file dialog; otherwise it rejects the operation. To download: use the website normally, then **Downloads → Save to device**. Files go into this app's private downloads folder, not your general Downloads. Only completed regular files up to 100 MB are listed; temporary/hidden files and symlinks are excluded. The newest 100 listed files are kept. Native dialogs/security warnings may require manual interaction. Larger/temporary downloads can still consume disk; use OS quotas for hard limits.

Keep the PC awake/unlocked, the app running, and the managed Chrome window available. Stop/Sign out closes the managed browser and retains its profile. An eight-hour app session is the default. Inactivity stops the managed browser after 30 minutes by default; local manual typing isn't tracked by the app's idle clock.

Native OS popup/GPU behavior varies. Some menus/dialogs may need local approval or keyboard interaction. Audio/video streaming, drag-and-drop, continuous pointer dragging and control of unrelated applications are not provided.

## Remote access from another device

The service binds to **127.0.0.1 only**. This is deliberate: do not expose desktop controls/passwords using public plaintext HTTP. For another device, use an authenticated SSH tunnel or a trusted HTTPS reverse proxy. You can optionally keep your existing VPS as a TLS gateway while Chrome runs on your PC; see [deployment](docs/deployment.md). Native website requests originate on the PC, not on that gateway VPS.

## Administrator and diagnostics

```bash
npm run setup-admin   # explicit first-run alternative
npm run reset-admin   # forgotten app password; existing sessions revoked
npm run doctor
```

Admin files and profiles live under `runtime/` by default. Don't copy the previous VPS .env to your PC; its public origin and secrets are not needed for local defaults. Existing admin hashes can be kept if deliberately reusing the same DATA_DIR; the new browser profile is separate.

Debug console includes retained live logs, filters, pause/resume, copy/export and clear. It omits typed text, passwords, URLs/query strings and website page/console contents. Native Chrome DevTools can show website details directly within the authenticated stream; those contents are not copied into server logs. No frame is sent to an AI provider.

## Tests and limitations

```bash
npm run lint
npm test
npm audit --omit=dev --audit-level=high
```

Playwright is a **development-only** dependency for testing the viewer, never the production Chrome host. The Linux native acceptance fixture uses OS input, capture, actual uploads/downloads and profile reuse; enable with RUN_NATIVE_TESTS=1 and TEST_CHROME set to installed Chrome. Production launch arguments exclude automation/headless/debugging and sandbox-disable flags. Trusted tests may relax sandboxing inside CI containers.

[Architecture](docs/architecture.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md) · [Test report](docs/test-report.md)

## Guided Gemini sign-in and background mode

Update with `git pull --ff-only` and `npm ci`. For the existing native desktop
mode, run `node app.js`, sign in to the dashboard, and choose **Start Gemini
sign-in**. The dashboard records actual launch/navigation steps and shows the
live browser. Enter your Google email/password and complete MFA directly in
Google's page in that stream. Then choose **Open Gemini after sign-in**, inspect
the page, and choose **I can see Gemini signed in**. This final state is your
confirmation; the app does not independently verify Google authentication.
This flow is for existing Google accounts. Account creation and security checks
remain interactive on Google's official pages.

For background control without focusing your macOS/Windows desktop, install and
start **Docker Desktop**, select Linux containers, and run:

```sh
npm ci
node app.js --background
# equivalent: npm run background
```

The first launch creates a **separate background administrator** in your
terminal and builds the Linux image. Open **http://127.0.0.1:3030** after
`SERVICE_STARTED`, sign in with that administrator, and use the same Gemini
assistant and browser controls. Stop the native app first if it already uses
port 3030. Linux can also use this command with a local Docker engine, or use
`node app.js` with its existing private Linux desktop.

Background mode captures an isolated Linux desktop, so it needs no macOS Screen
Recording/Accessibility permission. Keep Node, Docker and the PC running and
awake. Switching tabs or disconnecting the dashboard does not stop Chrome;
logout, Stop, cancellation, Ctrl+C or the configured idle timeout does. Browser
steps pause for your input; the app cannot complete MFA/CAPTCHA unattended.

Data lives in `runtime/background/` (or `DATA_DIR/background/`) including its own
admin, Chrome profile, downloads and private logs. Native and background sessions
are separate; no personal Chrome cookies are imported. Back up this directory
only while the workspace is stopped. To reset its administrator, stop background
mode and run `node --env-file-if-exists=.env scripts/background-admin.js`.

Docker runs as a non-root user, publishes only `127.0.0.1:3030`, and keeps the
Chromium sandbox enabled. Use a **local** Docker engine; remote engine contexts
are unsupported. Reserve about 4 GB RAM and disk space for the first image build.
If startup reports `BROWSER_SANDBOX`, the engine's kernel restrictions need
attention: see [container notes](container/README.md). Google can still reject
sign-in; there are no stealth settings or security-check bypasses. Physical
Docker Desktop and live Google login are **UNVERIFIED** until tested on your PC.
