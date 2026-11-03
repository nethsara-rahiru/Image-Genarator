# Remote browser rebuild

2026-10-26: User requested removal/rebuild of the former project and clarified the new product: access a browser hosted on the VPS through their own browser. Branch feat/remote-browser-rebuild replaces tracked Gemini-platform files; prior history, runtime data and main are preserved until review/merge. No database data is deleted. The new product is a single Node process with a secure browser viewer, no Mongo/Groq/extension dependency, one persistent server profile, explicit CLI admin bootstrap/reset, tabs/input/navigation and original file transfers.

Implementation is complete for review. Local validation: 10 passed, 0 failed, 0 skipped; syntax/format, shell syntax and production audit pass. Standalone node app.js startup/bootstrap/shutdown smoke check passed. Desktop/mobile fixtures were visually inspected. Required checks: Node syntax/format, real Chromium fixtures, API/WebSocket authorization/CSRF/revocation, public network boundary, profile persistence, uploads/downloads, responsive viewer and dependency audit. CI installs Chromium and runs these checks on Node 22. No target VPS, Google login or real public TLS integration has been validated in this build session. No main merge or release tag is inferred from the earlier project's merge authorizations.

Continuation: review the rebuild PR and required checks. After authorized merge (or deliberate reviewed branch deployment), follow docs/deployment.md, stop the old PM2 apps, install dependencies and Chromium under dev, configure origin, create the new admin, start node app.js and complete the live acceptance checklist in docs/test-report.md. Preserve .env/runtime privately; never commit secrets or user browser frames.

Startup diagnostic repair: the user's deployed viewer reported a generic startup failure. Added a safe classified viewer/API error and npm run doctor (isolated empty profile, sandbox enabled). Local full suite: 12 passed, zero failed/skipped; two regressions verify classification and safe API output without exposing raw launch paths/secrets. The actual VPS cause is still unknown pending its launch diagnostics; Ubuntu 26.04 sandbox restrictions are a hypothesis, not a verified diagnosis. Original main CI at 93f4eaa completed successfully.

User then requested a proper debug console and Google search after another generic action error. Both are implemented on the existing diagnostics PR #7 (scope expanded to one deployable update): live authenticated console, retained/rotated JSONL, filters/pause/copy/export/clear, correlation IDs and safe action/network errors; Google query/URL resolution and shortcut; scroll throttling. Current local suite: 17 passed, no failures/skips. Node syntax/Prettier and production audit pass. Source was tested with real Chromium fixtures; no live Google or target VPS authentication is claimed. Await current PR CI and authorized merge before main deployment; alternatively deliberately check out the reviewed PR branch.

2026-10-26: User grants standing authorization to merge completed changes into main once required checks pass; do not ask again for each PR. PR #7 merged at 68dd9d9; main CI passed. User reports Google search blocked by destination policy after browser starts. Inspection found overbroad IP tests rejecting all 2001:: IPv6 and 192.0.0.0/16. Branch fix/public-address-classification replaces prefix guesses with precise Node BlockList CIDRs, retains private/link-local/metadata/transition/reserved restrictions and mixed-DNS rejection, and logs a safe block reason without DNS IPs/URLs. Local validation: 20 tests pass, none fail/skip; syntax/Prettier pass. Merge this fix after required checks. Actual VPS DNS results still need live confirmation after update; do not claim the exact DNS answer is known.

## Local native desktop rebuild — 2026-11-02

User requests recreating the browser on the working local PC, automatically detecting OS instead of asking which one. Branch feat/local-native-browser replaces production Playwright with installed desktop Chrome/Edge, native Windows/macOS adapters and a private Linux Xvfb display. It preserves admin identity/reset, authenticated viewer, Google search, file transfers and sanitized diagnostics. node app.js now detects the OS, offers interactive first-run admin bootstrap and opens the viewer. OS permission dialogs and one-time dependency installation are explicit; no silent bypass is attempted.

Google sign-in improvement is a compatibility goal, not a guarantee. Native website traffic originates on the host PC. A private validated DNS-pinning HTTP/CONNECT proxy retains network checks without a Chrome debugging/automation connection. A dedicated native-profile preserves earlier Playwright data untouched. Windows/macOS window capture/control code is implemented but real device permissions/capture/sign-in remain UNVERIFIED. Linux native fixtures run in a dependency-equipped test container because the managed outer executor has no sudo/package-install rights; Docker is a test harness, not an app dependency.

Standing merge authorization remains: create a feature PR, let required checks pass, merge to main without asking again, verify resulting commit/CI state. Continue from latest test evidence/PR. No release tag or live Google login is inferred. Docs/deployment.md covers local usage, OS prerequisites, secure second-device access and optional existing VPS reverse-SSH/TLS gateway; the latter still needs user validation.

Local evidence for this rebuild: Node 22 dependency-equipped Linux container full suite 17 passed, 0 failed, 1 Windows/macOS helper-load check skipped. Native GTK upload, original download, input, profile lease/reuse and real viewer passed. Previous tests remain historical evidence for the earlier headless implementation; current docs/test-report.md describes the native product. Windows/macOS helper loading and all matrix checks must pass before automatic authorized merge. Full real-device capture/sign-in stays unverified.

## macOS diagnostics and Google sign-in — 2026-11-03

User's Chrome opens but viewer reports the same blanket permission error; they ask for Google sign-in automation. Branch fix/macos-diagnostics-google-signin adds fixed official Google account-chooser navigation via the existing Chrome profile's normal URL invocation, independent of native keyboard/capture permissions. Passwords/MFA remain interactive in Chrome; retained sessions are reused where Google allows. No credential collection/security bypass or live-login success is claimed. macOS helper now separates missing windows/focus/Automation/Accessibility/capture/bridge failures, handles opaque CF window-list conversion, and reports read-only permission/window-query/managed-window counts via doctor. Also deduplicates network socket tracking to avoid listener growth on HTTP keepalive.

Local validation: Node 22 native Linux container suite 21 passed, 0 failed, 1 non-Linux helper-load check skipped. Sign-in URL opening was routed to a local fixture, succeeded with native key control deliberately disabled, and preserved the existing managed PID/profile. Mocked JXA regressions cover CF conversion, missing windows, permission/error classification, secret omission and read-only diagnostics. Real macOS permission/capture and real Google login remain UNVERIFIED; three-OS CI must pass before the standing-authorized merge.

CI passed the macOS read-only helper diagnostics. One native Linux duplicate run exposed a pre-existing focus race in omnibox typing (truncated URL in the fixture artifact). Viewer navigation/search now uses the same standard URL-opening mechanism as Google sign-in, opening a new tab and avoiding keyboard/capture permission dependencies. Native Chrome's own address bar remains available for same-tab navigation. GTK chooser location focus receives a short native-input settling interval. Re-run all three OS checks before merge.

## Guided Gemini and background desktop — 2026-11-03

Branch `feat/gemini-background-flow` adds an authenticated guided sign-in flow
with real step timestamps, bounded launch/navigation, cancellation, stale-ID
checks and explicit human authentication/confirmation. All interaction remains
inside Google's official browser page; no password forms, cookie import,
CAPTCHA/MFA bypass or programmatic authentication claim was added. Flow state
is replayed on WebSocket reconnect and its sanitized events persist in the log.
Capture failures no longer suppress status updates or the Stop control.

`node app.js --background` / `npm run background` launches the same application
and a headed, sandboxed Chromium on an isolated Linux desktop through a local
Docker engine. macOS/Windows require Docker Desktop with Linux containers once.
It uses a separate administrator/profile under DATA_DIR/background, private
loopback publication, a source-only image context, non-root user, resource limits,
namespace seccomp policy and graceful shutdown of its own created container ID.
Native Linux is already background capable; native Mac/Windows focus limitations
remain explicit. Linux chooser-window destruction is handled while verifying
that its private X display remains alive.

Local evidence: 27 tests, **26 passed, 0 failed, 1 OS helper check skipped** in
Node 22/Linux with real Chromium. Includes guided flow UI/API, original uploads
and downloads, persistent profile reuse, responsive authenticated stream and
local fixture-only Google/Gemini navigation. Host tests: 25 passed, 2 native/OS
checks skipped. Lint and production dependency audit pass (0 vulnerabilities).
Production-only Docker image successfully launched Chromium with the sandbox
**enabled** as a non-root user and captured its private desktop. Full launcher
smoke built the image, authenticated its separate admin, checked protected health
and shut down cleanly on SIGINT with exit 0. No real Google credentials or pages
were used for these acceptance fixtures. Physical Docker Desktop on Mac/Windows,
Google sign-in, MFA and Gemini availability remain **UNVERIFIED**.

PR [#11](https://github.com/nethsara-rahiru/Image-Genarator/pull/11) contains
commit `5dbad00`; all three OS jobs and the production-container smoke passed
on both push and pull-request workflows for that revision. Final hardening uses
a private 1 GB /tmp tmpfs for ephemeral browser/display files (the repeated local
image builds exhausted the managed overlay; the tmpfs production smoke passed).
Merge under the user's standing authorization only after the final revision
checks/reviews pass; GitHub PR state is authoritative. After merge the user runs npm ci,
starts Docker Desktop, runs node app.js --background, and completes Google
sign-in in the live browser. No release tag is authorized or implied.
