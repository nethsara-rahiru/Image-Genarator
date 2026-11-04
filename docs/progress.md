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
On Unix hosts the container uses the host UID/GID so private bind-mounted data
remains accessible without relaxing its permissions; image sources are readable
by arbitrary non-root UIDs and HOME is private-container /tmp. CI tests UID 1001.
That check caught a D-Bus requirement for a real passwd entry; the image now
creates the corresponding account during build using host UID/GID build args.
Merge under the user's standing authorization only after the final revision
checks/reviews pass; GitHub PR state is authoritative. After merge the user runs npm ci,
starts Docker Desktop, runs node app.js --background, and completes Google
sign-in in the live browser. No release tag is authorized or implied.

## Temporary sign-in inputs — 2026-11-03

User explicitly requests collecting email/password/other requested data in the
system interface, superseding their original no-app-password-form constraint.
Branch feat/transient-signin-inputs adds a one-value-at-a-time dialog to the
active guided flow. It masks password/code fields, requires the user to verify
Google's address and focus the correct native field, clears values on send or
cancel/close/logout/page exit, and uses the existing authenticated CSRF-protected
text-input API without storing values in settings, logs or flow state. No Google
credentials are requested in chat. Native OS control cannot verify DOM field
identity, so the interface states that limit and does not auto-submit Next.
Live Google and target-device validation remain unverified. Regression fixture
checks delivery of a synthetic secret, masking, clearing and absence from logs
and flow state; CI checks must pass before the standing-authorized main merge.

## Gemini-first observation and Groq recovery — 2026-11-03

Branch feat/gemini-observed-login implements the requested observed automation:
open Gemini first; stop on corroborated account/editor controls; only when signed
out proceed to Google. Recognized email/password/verification steps generate
short-lived token-bound dashboard inputs, verified against exact origin and
visible field before fill/one Next submission. Ambiguous results require review;
security checks require user participation. Check again never replays input.

Manual native mode remains available. Automatic DOM observation requires a
private stdio CDP pipe (no public debug listener); starting automation can restart
the existing managed browser with its saved isolated profile. It is not a stealth
or Google restriction bypass. Google, localized selectors, physical Mac/Windows
and live Groq/model compatibility remain UNVERIFIED.

Groq is configured in the authenticated dashboard, with its key stored only in
private server groq.json; native env configuration is also supported. Unknown
steps use at most two bounded JSON proposals over enum navigation candidates,
never credentials, account labels, raw DOM or screenshots. Only constrained
click/wait/ask_user operations are accepted and targets/postconditions rechecked.
Missing/rejected Groq produces a human handoff; no key is requested in chat.

Local tests pass: 37 total, 36 passed/1 OS helper skip in real native
Linux, 35 passed/2 skips on the host. Includes the complete signed-out fixture
flow and already-signed-in restart without credential requests, secret omission,
blocked/ambiguous/security states, stale input, Groq injection/timeout/schema and
settings access checks. Navigation waits for the new document loader and stable
UI observations, avoiding classification of a previous tab document while a new
page loads; delayed fixture responses cover this case. Native integration also exercises a mocked Groq repair
on ambiguous chooser controls before credential entry and checks that an already
signed-in restart makes no Groq call. Updated container smoke verifies the private pipe with
sandbox enabled. Push the tested branch, open PR, wait for all final checks and
merge under standing authorization. Continue with target live acceptance after
merge; no release tag is implied.

PR [#13](https://github.com/nethsara-rahiru/Image-Genarator/pull/13) contains the
Gemini-first flow and follow-up navigation/security guards. Complete push
workflows passed on earlier revisions. Repeated PR-only Ubuntu timeouts occurred
in the existing native upload fixture before Gemini automation started; its saved
screenshot showed the file chooser had not opened. The fixture now uses measured
native pointer coordinates and checks chooser visibility, with one bounded
activation-click retry. It still supplies the original file through the actual
native chooser and verifies exact uploaded bytes. Final local native suite:
36 passed/1 OS helper skip. Require the final revision's three OS checks and
production sandbox/pipe smoke to pass before the authorized merge. Live Google,
Groq and physical desktop acceptance remain unverified as above.

## Local no-login image generation — 2026-11-03

User requests removing the application's startup login, generating an image from
a dashboard prompt, managing chats, and returning the actual Gemini chat ID.
The user explicitly selected **Local no-login app with browser controls**.
Public anonymous access is outside this change. Preserve runtime profiles,
credentials and existing work; do not delete old administrator files.

Execution blocker: the selected coding environment became unavailable.
The environment tool reports connectivity offline; shell execution returned
409 environment_offline ("Environment is not connected"). The attempted branch/
repository inspection command did not execute. GitHub connector access still
works, so this continuation note is committed on feat/open-image-generator.
No application changes for this request have been implemented or tested.
Do not describe the existing main branch as an image generator or no-login app.

Implementation continuation:

1. Inspect repository state and fetch feat/open-image-generator after restoring
   the workspace. Preserve the existing PR #13 browser/sign-in/Groq work.
2. Remove first-run administrator prompts from app.js and the background launcher.
   Make local dashboard access require no application password. Retain exact
   Host/Origin checks, CSRF and loopback binding. Reject accidental public
   no-auth configuration. Google authentication is separate and remains required.
3. Add a real prompt form, new/resume-chat selector, job progress/history,
   actual chat ID/link, and output preview/image/JSON downloads.
4. Implement one generation job at a time with durable local FIFO state, a
   process lease, cancellation, idempotency and crash recovery. A submitted or
   ambiguously submitted prompt must become needs_review after interruption;
   never silently resubmit it.
5. Extend the fixed private-pipe adapter to create/reopen Gemini conversations,
   verify the selected account/chat, record response baselines, enter the image
   prompt, submit once, and observe the current response. Keep site checks and
   model action restrictions. Obtain the chat ID from Gemini's actual
   /app/<conversation-id> URL, never a fabricated local ID.
6. Select the first valid image in the new response, excluding prior chat images
   and uploads. Prefer its website download action. Associate browser download
   events with the controlled frame/job and save into a private job directory.
   Validate signature, nonzero bytes and actual dimensions/format; retain the
   original bytes plus metadata/checksum. Do not analyze image content.
   Text-only responses must explicitly report no image, not produce a screenshot.
7. Pause on login requirements, blocks, limits and unsupported UI. Google has
   already rejected a live sign-in for this user; this work cannot promise to
   bypass that restriction. Existing Groq recovery must not receive credentials,
   login screenshots or secret page content.
8. Add local Gemini-like fixtures for new/resumed chats, current-response
   association, multiple images, no image, interrupted download, cancellation,
   restart/duplicate submissions, and no-login Host/Origin/CSRF access. Update
   deployment/API/security/progress/test documentation and run required checks.
9. Commit/push tested changes, open the feature PR, and merge under the user's
   standing "always merge to main" authorization only after required checks pass.
   No release tag or live integration validation is implied.

Needed external action: reconnect/restart the coding environment. Live Gemini
image generation and the target PC still need authorized user validation after
implementation; never request Google passwords or API secrets in chat.

### Resume attempt and second environment outage — 2026-11-03

The environment returned connected and shell commands worked. The local
feat/open-image-generator branch was checked out from origin and implementation
began. The environment then disconnected again while creating new tests; status
is offline and exec-server recovery failed. Available environment tools can
inspect status but do not offer a restart/connect action.

IMPORTANT: application changes are currently in the workspace working tree,
not committed/pushed. The GitHub feature branch contains continuation notes only.
Do not overwrite the workspace or claim the feature is merged/validated.

Confirmed working-tree changes before the second outage:

- app.js: removed interactive administrator bootstrap; default opens directly.
- src/config.js: AUTH_REQUIRED defaults false, rejects public no-login origins,
  adds GENERATION_TIMEOUT_SECONDS. Explicit protected legacy mode remains.
- scripts/background.js: removed password bootstrap and forwards AUTH_REQUIRED.
- src/server.js: anonymous local session bootstrap retaining CSRF/Host/Origin;
  optional protected mode preserved; generation API, worker lifecycle, busy
  browser ownership and WebSocket progress integrated.
- src/automation/pipe.js: emits browser download events over the private pipe.
- src/automation/adapter.js: supports validated real Gemini conversation IDs.
- src/generation/page.js: fixed local Gemini composer/response/image operations,
  hashed account binding, response baselines and scoped first-image selection.
- src/generation/imageInfo.js: original PNG/JPEG/WebP dimensions/signature/bytes.
- src/generation/runner.js: one prompt submission, current-response observation,
  actual chat IDs, frame-associated download events and original-byte download.
- src/generation/queue.js: leased local durable FIFO, idempotency, recovery,
  cancellation, chat catalog and original image/metadata output.
- public index/app/style: prompt form, saved chats, job progress/cancel/retry,
  gallery, chat IDs, image/JSON downloads; hides login/logout in local mode.
- Existing tests/security.test.js and tests/system.test.js were adapted to
  explicitly exercise the preserved protected mode.

Last confirmed check: existing baseline suite 37 tests, 35 passed/2 OS/native
skips after integration; syntax/Prettier were run during edits. This does NOT
validate new image generation or no-login/browser E2E.

The failing final command attempted to create tests/fixtures/png.js and
tests/generation.test.js, patch premature text-only detection in generation/page.js,
format them, and run the suite. Its execution was not confirmed. Inspect these
paths before recreating anything. If the patch is missing, textOnly must NOT be
reported while a generated image is still loading or lacks a recognized download
control; wait/pause instead of reporting a false no-image failure.

Next actions after reconnection:

1. Run git status/diff first; preserve all uncommitted implementation above.
   Fetch origin and incorporate this notes-only branch commit without discarding
   local changes. Inspect the final attempted test files before writing them.
2. Add/run queue and no-login API tests (no administrator, CSRF/Host preserved),
   image signature/dimension tests, lease/idempotency/recovery/cancel tests.
3. Extend real native local fixtures for generation: new and resumed real-style
   chat URLs, historical-image exclusion, multiple-image first selection,
   text-only failure, delayed/failed downloads, account change and restart.
   Real Gemini remains unverified; do not work around Google's sign-in rejection.
4. Review queue mutation races/durability and output path/symlink checks; ensure
   shutdown cancels current waiting/download operations and releases ownership.
   Forward the generation timeout into Docker if configured on the host.
5. Update README/.env/API/security/operations/test/progress docs, test the
   production container, commit/push tested changes, open the feature PR and
   merge only after final CI/reviews pass under standing authorization.

No new app behavior is available on main yet. Restore the coding environment to
finish; do not ask the user for Google passwords or API secrets in chat.

## Local generator implementation complete for review — 2026-11-03

The offline blockers above are historical. The workspace reconnected, the
existing changes were preserved, and source checkpoints were pushed as 696d6fc
and f85068a on feat/open-image-generator. The user's confirmed scope remains
local no-login access with browser controls; public anonymous access is not added.

Implemented: no administrator prompt/login by default (native and Docker), local
origin guard/CSRF retained, optional protected legacy mode, prompt-driven image
jobs, durable leased FIFO with serialized mutations, idempotency, safe retry/cancel
and restart recovery, actual Gemini chat IDs/catalog/local rename, hashed account
binding, current-response image association, original frame-bound downloads,
metadata/header/dimension/checksum checks, gallery and original image/JSON links.
History/source fingerprints exclude older images even when old nodes rerender.
Pending images are not misreported as text-only replies. Retry goes to the FIFO
tail; concurrent duplicates execute once; repeated deletion cannot remove another
job. Failed/oversized/incomplete downloads are cancelled. Potentially submitted
prompts never auto-resubmit. Existing admin files/profiles are preserved.

Validation evidence: full Linux native suite 48 tests, 47 passed, 0 failed,
1 OS helper check skipped; host suite 45 passed/3 native/OS checks skipped.
Fixtures cover new/resumed chats, actual returned conversation URLs, multiple
images/first current image, original bytes/metadata, old DOM replacement,
text-only/login/account mismatch, interrupted download/cancel, no-login UI,
queue lease/idempotency/FIFO retry/shutdown/corrupt journal/symlink/concurrent
mutation regressions. Desktop/mobile generator screenshots are synthetic only.
Production smoke passed with the real Chromium sandbox/private pipe, capture,
no-admin session bootstrap and generator API. Lint and production audit pass;
0 vulnerabilities reported. Updated docs include api.md and operations.md.

Finish: push the final tested revision, open the feature PR, wait for all final
CI/reviews and merge using the user's standing authorization. No release tag is
implied. Real Google sign-in, Gemini image-generation/download selectors, actual
Groq/model availability and physical Mac/Windows/ARM acceptance remain UNVERIFIED.
Google's insecure-browser rejection still requires its supported sign-in flow;
this app does not bypass it or guarantee that Gemini will return an image.

## Manual sign-in and image download follow-up

- Google sign-in is manual in the opened Chrome window. The flow observes Gemini
  and asks the user to sign in; credential collection/submission and Groq sign-in
  recovery are disabled. Check again verifies actual signed-in UI.
- Removed the browser preview canvas, input handlers and screenshot streaming.
  Generated image previews remain enabled.
- Image download scrolls/hovers the selected current-response image, waits for
  its toolbar, supports full-size labels and child-frame download events, and
  retains original-file verification and duplicate-submission protection.
- Browser fixture uses hover-only download controls and verifies exact image
  bytes and a loaded image in the dashboard. Real Google/Gemini remains unverified.
- Host tests: 46 passed, 3 environment skips. Full native Linux suite: 48 passed, 1 OS helper skip. CI results are
  recorded in the follow-up pull request. No Google security bypass is added.

## Studio UI / UX reorganization

- Replaced the browser-first layout with a responsive image workspace: session
  connection, prompt composer, jobs/results and saved conversations.
- Added section navigation, result filters (all jobs/images/needs attention),
  readable job status badges, empty states, keyboard focus and a skip link.
- Browser controls and AI settings are collapsed secondary tools. Diagnostics
  and browser downloads remain available. Manual Google sign-in is unchanged.
- Removed all remaining browser preview canvas/empty-screen styles. Generated
  image previews and original-image/JSON downloads remain available.
- Validation: host suite 46 passed / 3 environment skips; native Linux suite
  48 passed / 1 OS helper skip; lint passed. Chromium fixture verifies keyboard
  focus, collapsed browser controls, downloads expansion, real image downloads,
  result filtering and no horizontal overflow at 390px. Desktop/mobile synthetic
  fixture screenshots are CI artifacts, not committed runtime data.
- Live Google/Gemini integration remains separately UNVERIFIED; this change does
  not alter account sessions, automation or output storage.

## Original-image download timeout repair

- Replaced JavaScript element.click with validated hit-tested CDP mouse input and
  user activation. Added dynamic child-frame verification and safe buffering of
  download progress while verifying a new frame.
- Added download-only recovery for new and older failed jobs. New jobs persist an
  image fingerprint; older jobs require a unique exact prompt/response match.
  The same account/chat is required. The recovery path cannot fill or send prompts.
- Added sanitized click/start/verified download events and separate no-start vs
  stalled-transfer timeout messages. Original image signature/size checks remain.
- Regression fixtures require trusted click/user activation, start downloads in
  new iframes, verify exact original bytes, recover both checkpoint/legacy jobs
  with unchanged submission counts, and reject ambiguous response associations.
- Live Gemini behavior remains UNVERIFIED until tested with the user's account.
  Final automated evidence and CI links are recorded in the follow-up PR.
- CI exposed two intermittent failures in the existing OS-input fixture (textbox
  activation and a cancelled native chooser). The fixture now waits for a real
  input acknowledgement before submitting and permits up to three attempts only
  after a confirmed chooser cancellation. Production prompt submission never
  retries. The image-download fixture passed in both original CI runs.

## Named downloads and completion reconciliation

- Removed Chrome allowAndName mode, which deliberately produced extensionless
  UUID filenames while the app waited for completion. Downloads keep their
  website filenames in fresh per-attempt folders, then verified image bytes are
  renamed to image.png/jpg/webp for the job and shown in the dashboard.
- Completion reconciles a single stable valid image file instead of depending
  solely on Browser.downloadProgress. Partial/unsafe/multiple files are rejected;
  cancelled jobs release listeners/timers and restore normal browser downloads.
- Page.frameAttached records verified child frames, including short-lived frames
  which may disappear before a frame-tree snapshot. Download-only recovery never
  submits another prompt.
- Regression tests cover missing completion events, short-lived child frames,
  partial-to-final file rename and ambiguous files. Real Chromium fixture drops
  all completed progress events and still verifies original bytes and dashboard
  output. Live Gemini remains UNVERIFIED; final CI evidence is in the PR.

## Versioned public HTTPS client API

- Added /api/v1 bearer authentication independent of dashboard sessions/CSRF.
  Keys are hashed at rest, scoped (read/generate/browser), expiring, revocable
  and rotatable through the local api-client CLI. No secrets are committed.
- Added browser start/stop/status/open-Gemini, enqueue/poll/list own jobs,
  client-owned chats, image/metadata downloads, cancel/safe retry/download-only
  recovery. Idempotency is scoped to the client. The queue remains globally FIFO.
- Public API keeps existing Host/TLS checks; public dashboard configurations
  require AUTH_REQUIRED=true. Browser controls share the host's Google session;
  this is a trusted-client service, not isolated tenant browsers. Google sign-in
  remains manual. No arbitrary browser code/navigation or profile APIs are added.
- API integration tests cover auth, revocation/rotation/expiry, scope denials,
  ownership, original bytes/metadata, pagination, rate limits, HTTPS/Host checks,
  idempotency isolation and unchanged dashboard CSRF/auth enforcement.
- Public DNS/TLS deployment and live Google/Gemini require target validation.
  docs/client-api.md contains provisioning, HTTPS deployment and curl examples.
  Automated results and final commit/PR references are recorded in the PR.

## Guided LAN HTTPS startup

- Added node app.js --lan: detects/chooses a private assigned IPv4 interface,
  guides secure administrator bootstrap, manages the Node + Caddy lifecycle,
  remembers LAN settings and prints the Postman API URL and CA-import instructions.
- Reuses installed Caddy or downloads a pinned official platform release, checking
  its published SHA-512/SHA-256 checksum before extracting only the executable.
  Does not install system services, modify .env or globally trust a private CA.
- LAN mode requires dashboard authentication, keeps Node on loopback, binds Caddy
  to the selected LAN IP and disables its administration listener and HTTP redirects.
  Private PKI/runtime files are never served. First bearer key is shown only in
  an interactive terminal when no active API clients exist.
- Integration uses real Caddy to verify TLS/CA trust, protected API/dashboard,
  restart with the same CA, unchanged .env, managed shutdown and failed-bind cleanup.
  CI prepares verified Caddy on all supported runner operating systems.
- Physical second-PC certificate import, OS firewalls, macOS/Windows browser
  permissions and live Google/Gemini remain UNVERIFIED until target validation.
  Final automated evidence and PR references are recorded in the PR.

## README API and output reference

- Expanded README with every v1 route, required scopes, request headers/bodies,
  Postman/LAN/TLS/token setup, curl workflow, job polling and original-image/JSON
  output behavior. Response excerpts are explicitly illustrative, not live results.
- Added complete dashboard route inventory and separate session/CSRF requirements,
  plus WebSocket scope, error/status guidance, limits and recovery behavior.
- Checked route and output field names against clientApi.js, server.js and the
  generation queue. Removed obsolete README claims of automated Groq Google login.
- Documentation-only change; Markdown formatting/link checks are recorded in PR.

## Open dashboard request

- Removed administrator bootstrap/login from LAN mode, including overrides of
  older AUTH_REQUIRED=true settings. Existing administrator hashes are preserved.
- Allowed no-login HTTPS origins; plaintext network origins remain rejected.
  Normal mode retains explicit optional AUTH_REQUIRED=true support.
- API bearer tokens, scopes/ownership, HTTPS, exact Host/Origin and CSRF checks
  remain. The open dashboard intentionally exposes the shared browser/jobs/outputs
  to everyone who can reach it; it is not tenant-isolated.
- LAN integration now starts without any admin file, verifies open dashboard/session
  access despite old .env auth settings, and still requires a token for /api/v1.
  Final checks and CI evidence are recorded in the follow-up PR.

## Continued live download timeout: diagnostics and manual output recovery

- Live cause is not confirmed: user could not identify a Chrome download/dialog.
  Avoid claiming another fully validated live-Google automatic fix.
- Added instant scroll and final button geometry/hit-test; provider preparation
  network activity can extend the no-start wait within the existing job deadline.
  Logs retain only fixed events/counts, never request URLs/bodies/credentials.
- Added consent-based Attach downloaded image for eligible failed download jobs,
  including extensionless original files. Checks real PNG/JPEG/WebP bytes/size,
  isolates writes, prevents symlink escape/completed overwrite and preserves job
  ID/chat/prompt without another submission. Source/provenance is explicitly
  manual/user-confirmed, not automatically verified. Upload concurrency is one.
- Regression tests cover delayed preparation, smooth-scroll pages, real browser
  manual attachment, metadata/source flags, no resubmission, invalid bytes/consent
  and unsafe output paths. Final CI/automated evidence is recorded in the PR.

## Download-control movement regression

- The last final-position guard was too strict: movement over one pixel or a
  re-created toolbar button stopped a valid download before clicking. This was
  introduced by the previous change, separate from the earlier unverified timeout.
- Added bounded reacquisition of the same image fingerprint/account/saved chat,
  accepting a new matching toolbar node. Uses nearest instant scrolling and
  sends exactly one download click after the control settles; never resubmits.
- Regression fixture moves and replaces the button on hover. Unit coverage also
  checks continuously moving controls and real image/chat changes without clicks.
- Earlier live Gemini timeout remains separately unverified. Final CI evidence
  and commit/PR references are recorded in the PR.
