# Test report — implementation candidate

2026-10-25, Codex Cloud Linux, Node 24.19.0. CI separately uses Node 22. Original implementation suite: **33 passed**, no failures; explicit live acceptance test is skipped unless RUN_LIVE_GEMINI=1. Syntax/Prettier checks and bash syntax checks passed. Production dependency audit after upgrading Sharp: **0 vulnerabilities**. These are development checks, not a production security audit.

## Automated evidence

| Area                  | Evidence                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config and encryption | Reject public bind, HTTP origin, weak secret, root/public storage                                                                                                                                                                            |
| Auth                  | Argon2 admin, unique singleton, login/logout route guards, wrong-password rejection, real HTTPS Secure/HttpOnly/Strict cookies, CSRF/origin checks                                                                                           |
| API                   | Account/chat CRUD, pagination, strict settings DTO, cross-account rejection, authorized output downloads and confirmed deletion                                                                                                              |
| Queue                 | Simultaneous idempotent submissions, hash conflicts, FIFO claims, five competing lease acquisitions, lease expiry/fencing, stale-owner rejection, OS flock across processes                                                                  |
| Reliability           | Crash-boundary state reconstruction, persisted-output reconciliation, queued cancellation, explicit ambiguous retry, retry budget, DB disconnect rejection                                                                                   |
| Browser               | Local Chromium fixtures: response baseline excludes old images, no-image failure, deterministic first download among multiple images, interrupted download, locator repair/reuse, no caching on failed postcondition                         |
| Worker pipeline       | Actual fixture upload → send → current response → browser download → exact original bytes + actual dimensions/format/size → JSON → completed job; no-image and expired-account failures                                                      |
| Profiles              | Actual persistent Chromium cookie survives context restart; separate profile has no cookie; per-account profile Mongo exclusion                                                                                                              |
| Recovery              | AI disabled makes no request, network timeout/malformed responses bounded to three calls, strict proposal rejects shell/code/URL injection, verified cache avoids AI                                                                         |
| Dashboard             | Real HTTPS API/session store; all nine pages; account creation; queue submission with simulated lost acknowledgement and idempotency reuse; remote saved-chat viewer; desktop + 390px responsive layout; no JS errors; actual SSE connection |
| Login viewer          | Local browser fixture frames over authenticated WSS, verification/close flow, cross-origin WSS rejection; no live Google login                                                                                                               |
| Monitor               | Worker-only current-response image crop written locally; login/unauthenticated capture refused; associated deletion clears capture                                                                                                           |

CI uploads desktop/mobile **fixture dashboard** previews as artifacts; no login screenshots or real account data are captured. Fixture previews are not committed to the repository. Latest local test output and temporary artifacts are under /tmp in this session; durable evidence is this report and GitHub Actions.

## Explicitly UNVERIFIED

- Actual Google login, MFA, captcha/security/usage restrictions, and whether Google permits session reuse with headless Chromium on target VPS.
- Real Gemini selectors, current upload preview markers, generation completion indicators, image-specific download association, chat resume and refusal/limit detection. A changed UI fails safely and may require locator updates. Never promise image generation.
- Real Groq credentials/model availability, structured output support, network timeout latency and billing/usage. All automated recovery calls use controlled mocks; vision is optional and not implemented/enabled.
- A real OS process kill during live submission/download; automated tests reconstruct interrupted persisted states and test OS lock exclusion rather than killing a live Google session.
- Full Mongo network-partition/failover behavior; test disconnects the client and checks lease fencing. Standalone Mongo only; distributed worker deployment unsupported.
- Google attachment rejection on current UI, actual Google block/captcha screens and interrupted downloads from Google (fixture contracts cover these classes only).
- Ubuntu installer execution on fresh target VPS, PM2 reboot/systemd startup, TLS trust installation, firewall exposure checks, backup/mongorestore drill and disk exhaustion under load.
- Session lifetime elapsed for a full hour, accessibility audit with assistive technology, external penetration test and sustained multi-hour load test.

## Target VPS acceptance

1. Deploy reviewed immutable commit using docs/deployment.md; verify non-root processes, localhost-only app listeners, trusted HTTPS via SSH tunnel, no debug/VNC ports, 0700/0600 permissions.
2. Bootstrap admin in an SSH terminal. Test wrong password, CSRF denial, logout, password rotation and session invalidation. Open all pages on desktop/mobile.
3. Add two Google accounts. Login/MFA through viewer directly; verify identity labels manually. Close viewer, restart API/worker, confirm allowed session reuse; expire a session and verify needs_login. Do not bypass security checks.
4. Create, title and resume a conversation for each account. Try cross-account job and confirm rejection. Upload PNG/JPEG/WebP logos; test invalid/oversized assets.
5. Generate several approved test prompts; confirm one original image from new response, correct metadata and no old-chat image selection. Test text-only/refusal result explicitly.
6. Queue several jobs and start a second worker; verify FIFO and no overlap. Cancel before/after send, stop/restart worker before/after submission and during download; confirm needs_review and no automatic resubmission.
7. Configure Groq key in protected .env and enable recovery only with a schema-capable text model. Test changed locator in a controlled fixture, inspect usage events and reuse verified cache. Never transmit login screens.
8. Verify SSE replay/reconnect, image/JSON authorization, monitor cropping, retention and confirmed cleanup.
9. Stop both processes, back up, restore to an isolated environment, compare checksums and reconnect accounts as needed.
10. Record date, VPS versions, reviewed SHA, pass/fail and sanitized evidence here. Only then authorize merge/release gates and v1.0.0.

Optional opt-in generation test on VPS: with PM2 worker already running and a verified account, set non-secret RUN_LIVE_GEMINI=1, LIVE_ACCOUNT_ID and an explicitly approved LIVE_PROMPT in your protected local environment, then `npm run test:live`. It makes one real queued request, may consume Google quota, retains its output and fails explicitly if no image is returned. Default CI never makes this request. Do not put passwords/API keys into test fixtures or chat.

## Recorded GitHub CI

Node 22 runs [40181254723](https://github.com/nethsara-rahiru/Image-Genarator/actions/runs/40181254723) and [40181293859](https://github.com/nethsara-rahiru/Image-Genarator/actions/runs/40181293859) passed at implementation 77a7522. Final dashboard E2E passed separately after the visible running-count adjustment. A controlled shell check also confirmed backup refusal for online services, invalid PM2 data and an active worker OS lock, plus offline archive creation with mocked mongodump. This is not a real Mongo backup/restore acceptance test. Check the latest PR head status for subsequent documentation/backup hardening changes.

## Login viewer lifecycle fix — 2026-10-26

Local full suite: **38 passed, 1 opt-in live test skipped**. Five new Chromium/Mongo regressions verify that a failed verification preserves the browser, allowed Google popup tabs become the active page, expiry releases the profile lease, lost profile ownership closes with a distinct reason, and navigation capture failures preserve the stream while queued input remains ordered and revoked administrator sessions still terminate it. The HTTPS/WSS dashboard E2E additionally interrupts the viewer connection, forces a screenshot failure, verifies automatic reconnection to the same browser, checks that unsuccessful verification remains interactive, and uses Open Gemini before successful verification. Test pages are controlled local Google-like fixtures; the user's actual VPS and live Google login remain unverified.

## Local browser mode — 2026-10-26

Full local suite: **51 passed, 1 opt-in live test skipped**. Device protocol tests use actual temporary MongoDB and API middleware. The dashboard HTTPS E2E creates a pair code, pairs a fixture computer, downloads the standalone ZIP and binds an isolated browser profile. A real unpacked Chrome extension runs against controlled Gemini fixtures, transfers a reference image, fills/submits a prompt only after a permit, scopes its response, uses Chrome Downloads to download/rename files, rejects an invalid first candidate and uploads the first valid original. That test uses Playwright/CDP only as its Linux test harness; production extension execution opens no CDP/debug ports and requires no Playwright. Standalone ZIP extraction and bare `node app.js` startup are verified without npm packages. Loopback origin/host/CSRF, extension authorization, path/symlink guards, actual PNG/JPEG/WebP dimensions, private CA trust, failed untrusted TLS and rejected redirects are tested. Device/asset scopes, simultaneous FIFO claims, one-use submission permits, durable barriers, successful output release and pre/post-submission recovery pass.

These fixtures are not evidence of successful real Google authentication, Gemini generation or Groq on a user's normal browser. Windows/macOS/Edge packaging and real downloads, browser policies/suspension, sleep/reconnect, current Gemini DOM and target VPS rollout require manual acceptance. Google security/usage restrictions must be surfaced, not bypassed. See docs/local-companion.md.

Follow-up regressions verify completed-output lookup after a lost acknowledgement, orphaned barrier release, stale account-command rejection and unique browser-profile ownership. The real extension fixture also verifies reopening the paired extension from the loopback launcher. Final local suite: 51 passed, 1 live test skipped.
