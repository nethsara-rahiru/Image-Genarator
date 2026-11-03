# Changelog

## Unreleased — private VPS browser rebuild

Replaces the previous Gemini platform with a single-process Node.js remote browser viewer: explicit administrator setup/reset, persistent Chromium session, authenticated live frames and input, tabs/navigation, file uploads/downloads, secure SSH/TLS deployment and controlled-browser regression tests. Previous source is recoverable in Git history. No MongoDB, Groq, worker, local companion or browser extension is required. Existing Atlas admin does not migrate; provision the new admin once. Target VPS/TLS/Google login remain unverified. No release tag or main merge has been performed for this rebuild.

## Unreleased — debug console and Google search

Adds private retained/live debug logs with filters, pause, copy/export/clear, per-action IDs/timings and safe network/browser cause codes. Adds Google search in the address bar and a Google shortcut. Includes startup doctor diagnostics and throttled scroll input. Actual user VPS diagnosis remains pending live log output.

## Unreleased — public destination classification

Corrects false blocks on legitimate public 2001:: IPv6 and 192.0.x.x IPv4 addresses using precise CIDR checks. Preserves private/metadata/mixed-DNS protection and adds safe block-reason diagnostics.

## Unreleased — local native desktop browser

Replaces production headless/Playwright control with OS-detected installed Chrome/Edge, native Windows/macOS window capture/control and private Linux desktop capture. Adds interactive first-run local bootstrap, normal Chrome DevTools shortcut, original native file transfers, profile locking and DNS-pinned browser proxy. Playwright is development-only. Local Chrome still may be rejected by Google; real Windows/macOS permissions and live Google remain unverified.

## Unreleased — Google sign-in navigation and macOS diagnostics

Adds official account-chooser navigation in the existing Chrome profile without requiring native capture/keyboard permission; credentials and verification remain interactive. Replaces blanket macOS permission errors with specific safe causes and read-only doctor checks. Fixes repeated socket-close listener registration on HTTP keepalive.

## Unreleased — guided Gemini and background workspace

Adds real launch/navigation progress, interactive Google sign-in pauses and
explicit user confirmation in the dashboard. Adds `node app.js --background`
using a non-root sandboxed Linux desktop container, separate private profile and
admin, loopback publication and owned-container shutdown. Native Linux remains
background-capable; Windows/macOS native control still needs foreground access.
Viewer state and flow steps remain visible when frame capture fails. Handles a
Linux chooser-window destruction race during upload. Live Google and physical
Docker Desktop integrations remain unverified.

## Unreleased — Gemini-first observed login and Groq recovery

Checks Gemini before login, stops on observed signed-in account/editor UI, and
requests only the current recognized Google input in the dashboard. Uses a
private automation pipe without network debugging ports, verified origin/field
filling, single Next submission, stale-token rejection and explicit security/
ambiguity handoff. Adds server-side Groq configuration and bounded recovery over
sanitized navigation candidates; credentials and login screenshots are excluded.
Manual native control remains available. Live integrations remain unverified.
