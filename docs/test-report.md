# Test report

## Automated scope

The rebuild uses real local Chromium against controlled fixture websites. Security checks cover private/metadata/unsafe URLs and DNS answers, configuration/transport restrictions, Argon2id identity bootstrap/reset, exact Host/Origin, CSRF, login rate limiting and revoked sessions. Browser checks cover pointer/text/key input, tabs, reference file chooser upload, original file download/authorized retrieval and persistent profile cookies. The real viewer E2E signs in, starts Chromium, streams frames, enters text from the user's browser and checks desktop/mobile layouts. WebSocket tests reject foreign origins and revoke an open viewer after a password reset.

Tests run with test-only private fixture routing and sandbox relaxation because the cloud test executor is root. Production never enables those overrides through environment variables or requests and refuses root browser launch. No real Google account, public site credentials or user data is used. CI screenshots show synthetic fixtures only.

## Live acceptance — UNVERIFIED

1. On the target non-root VPS, install Chromium/dependencies and verify the sandbox starts. Record OS/Node/Chromium versions.
2. Use SSH forwarding, create the administrator, verify login/logout and reset-admin, then inspect directory permissions.
3. If using public access, verify the valid/trusted TLS certificate, Caddy WebSocket upgrade, Host/Origin settings and firewall. Verify no public 3030/CDP/VNC listener.
4. Browse an approved public website, verify keyboard/scroll/navigation/tabs, then a small upload/download and checksum comparison. Check a disconnect/reconnect.
5. Stop/restart browser and PM2, verify permitted session reuse; some sites require fresh sign-in. Test the idle timeout.
6. If Google is needed, sign in manually and record accepted/rejected. Do not bypass a rejection or claim authentication is guaranteed.
7. Inspect disk/memory use, OS quotas and outbound private-network isolation. Complete an offline encrypted backup/restore drill.
8. Record sanitized results here before treating the build as deployed/fully validated. Windows/macOS are client browsers; the host target is Linux. Mobile touch/keyboard behavior still needs device acceptance.

## Recorded local evidence — 2026-10-26

Commit candidate on feat/remote-browser-rebuild: **10 tests passed, 0 failed, 0 skipped** under Node 24.19.0/Linux. Node syntax and Prettier passed; installer shell syntax passed; production npm audit reported **0 vulnerabilities**. A separate actual `node app.js` smoke check verified startup, unconfigured-admin bootstrap and clean SIGTERM shutdown using an isolated temporary DATA_DIR. Desktop/mobile fixture previews were visually inspected. Both anonymous and foreign-origin viewer upgrades are rejected; a credential reset also prevents already-queued actions from executing. CI validates Node 22 separately; use the rebuild PR's current check result as evidence.

## Debug console and Google search — 2026-10-26

Full suite: **17 passed, 0 failed, 0 skipped**. Added deterministic search/URL handling and safe error classification, bounded journal rotation/restart replay/clear, metadata omission, authenticated log API/filter/replay/export/CSRF, and controlled Google navigation tests. The real responsive viewer E2E opens/filters/pauses/resumes the console, exports its JSON, checks streamed frames and input, submits a search and uses the Google shortcut against a controlled fixture. Visual mobile inspection passed. Actual Google search availability and the user's VPS error remain unverified until deployment and live diagnostics.
