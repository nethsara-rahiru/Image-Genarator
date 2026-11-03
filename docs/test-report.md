# Local native browser test report

## Recorded Linux evidence — 2026-11-02

The complete Node 22 test-container suite passes **17 tests, 0 failed, 1 platform-specific helper-load check skipped**. The outer managed executor has no package-install privileges, so a disposable container supplies Chromium, Xvfb, xauth, xdotool, Openbox, ImageMagick, xprop and D-Bus. Docker is only the test harness; application users do not need it.

The native Linux acceptance test launches real **headed** installed Chromium on a private X display. It controls the browser with OS key events, captures the real desktop, verifies text submitted to a local fixture, downloads original bytes, uploads original bytes through the GTK chooser, rejects a second profile owner, restarts Chrome and verifies a persistent cookie. The authenticated viewer is tested in a separate Playwright test browser for live frames, login/logout, debug logs and responsive desktop/mobile layout. No Playwright/CDP session is attached to the browser being hosted. Screenshots contain only synthetic fixture content. The test harness relaxes sandboxing inside the test container; production arguments exclude that flag and still require a supported host sandbox.

Other checks cover Windows/macOS driver selection, absence of automation/debug/headless flags, installed-executable errors, fixed key validation, authenticated HTTP/WS and revocation, CSRF/Host/TLS/Secure cookies, managed file/symlink/partial-file guards, proxy HTTP/CONNECT private-address denial, journal replay/rotation/clear, search normalization, CIDR boundaries and safe startup errors. Production dependency audit and syntax/Prettier results are recorded in the PR checks. Runtime does not require Playwright; it is a dev dependency only.

## Cross-platform CI

The workflow runs Node 22 on Ubuntu, Windows and macOS. Ubuntu runs the full native Linux fixture using installed desktop Chrome. Windows compiles/loads the PowerShell/C# helper without capturing a user desktop. macOS loads the JXA helper with a nonexistent target PID and checks its safe response without sending user input. The Linux native acceptance fixture is deliberately skipped on Windows/macOS. Latest PR/commit check results are authoritative; helper loading is not proof that GPU capture, permissions, focus, native file pickers or Unicode input work on a real user's machine.

## Unverified integrations and target acceptance

- Real Google authentication/search and any other account login: **UNVERIFIED**. Google can still reject the PC/profile/network; no acceptance guarantee is made.
- Real Windows/macOS Chrome window capture and control, minimized/occluded-window behavior, permission prompts/policy and file pickers: **UNVERIFIED** until physical-device acceptance.
- Actual PC sandbox support, sustained resource use, sleep/lock/reconnect and OS startup tasks: require target validation.
- Existing VPS reverse-SSH/TLS gateway, firewall/TLS trust and connection loss: **UNVERIFIED**.
- Real user-profile backup/restore and website session reuse across devices/updates: **UNVERIFIED**.

Acceptance: install Node + normal Chrome, npm ci, node app.js, confirm OS detection and first-run admin, grant local OS permissions, open a public site, test click/typing/scroll/tabs/DevTools/upload/download, compare transferred bytes, stop/restart and check permitted session reuse. Test logout/reset revocation, PC sleep/lock/disconnect, and confirm that only the managed window/private display is captured. Validate trusted HTTPS/tunnel before exposing controls to another device. Use normal Google MFA/security flow; stop on rejection. Record sanitized evidence before calling the relevant target integration verified.

## macOS/sign-in follow-up — 2026-11-03

Node 22 native Linux container: **21 passed, 0 failed, 1 platform helper-load check skipped**. The sign-in navigation test maps the fixed Google URL to a controlled local fixture, disables native keyboard commands and confirms Chrome opens the target using the same managed PID/profile. It never contacts real Google. Added mocked JXA tests for CF bridging, missing windows, specific Automation/Accessibility errors, unknown errors, read-only permission diagnostics and secret omission. macOS CI now requires successful read-only window-query diagnostics and the exact WINDOW_NOT_READY result for a nonexistent target, rather than accepting any generic failure. Real target-Mac capture and Google authentication remain unverified.

## Guided Gemini/background follow-up — 2026-11-03

- Node 22/Linux full native suite: **26 passed, 0 failed, 1 platform helper check
  skipped** (27 total). Controlled fixture Google/Gemini navigation, live step UI,
  responsive view, native upload/download bytes, profile reuse and logout pass.
- Host suite: **25 passed, 0 failed, 2 OS/native checks skipped**. New flow cases
  cover human pauses, stale IDs, concurrent start/cancel, interruption of an old
  startup, sanitized failures and preventing confirmation after navigation error.
- Lint/syntax/format and production dependency audit pass; zero vulnerabilities.
- Production image: non-root Chromium with sandbox enabled, private X desktop
  and JPEG capture passed in the managed Linux Docker engine. No Playwright
  production dependency or browser debugging interface is used.
- Launcher smoke: image build, separate admin session, authenticated health,
  loopback publication and clean Ctrl+C shutdown passed on Linux.
- Actual Google authentication, Gemini session acceptance, account creation and
  Docker Desktop on physical macOS/Windows: **UNVERIFIED**. The app reports
  `user_confirmed`, never claims independent authentication verification.

Both push and PR workflows for `5dbad00` passed all four jobs (three OS tests
and production sandbox smoke). Private /tmp tmpfs hardening was then smoke-tested
locally after managed-overlay storage exhaustion; check the final PR revision
for its corresponding CI result.

CI now builds the production image and runs `scripts/container-smoke.js` without
no-sandbox flags, in addition to the existing three-OS test matrix. Its current
check results must pass before merge. Existing target acceptance still applies.

## Transient sign-in dialog

Native Linux regression suite: 26 passed, 0 failed, 1 OS helper skip. The controlled
local fixture receives a synthetic password through the real dialog and native
OS typing; checks verify masking, clearing after send/cancel and omission from
persistent log and flow snapshots. No real Google credentials are used. Existing
API auth/CSRF and password-reset revocation checks cover the reused input route.
Live Google and physical-device acceptance remain unverified.
