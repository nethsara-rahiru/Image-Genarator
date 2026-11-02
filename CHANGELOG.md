# Changelog

## Unreleased — private VPS browser rebuild

Replaces the previous Gemini platform with a single-process Node.js remote browser viewer: explicit administrator setup/reset, persistent Chromium session, authenticated live frames and input, tabs/navigation, file uploads/downloads, secure SSH/TLS deployment and controlled-browser regression tests. Previous source is recoverable in Git history. No MongoDB, Groq, worker, local companion or browser extension is required. Existing Atlas admin does not migrate; provision the new admin once. Target VPS/TLS/Google login remain unverified. No release tag or main merge has been performed for this rebuild.

## Unreleased — debug console and Google search

Adds private retained/live debug logs with filters, pause, copy/export/clear, per-action IDs/timings and safe network/browser cause codes. Adds Google search in the address bar and a Google shortcut. Includes startup doctor diagnostics and throttled scroll input. Actual user VPS diagnosis remains pending live log output.

## Unreleased — public destination classification

Corrects false blocks on legitimate public 2001:: IPv6 and 192.0.x.x IPv4 addresses using precise CIDR checks. Preserves private/metadata/mixed-DNS protection and adds safe block-reason diagnostics.

## Unreleased — local native desktop browser

Replaces production headless/Playwright control with OS-detected installed Chrome/Edge, native Windows/macOS window capture/control and private Linux desktop capture. Adds interactive first-run local bootstrap, normal Chrome DevTools shortcut, original native file transfers, profile locking and DNS-pinned browser proxy. Playwright is development-only. Local Chrome still may be rejected by Google; real Windows/macOS permissions and live Google remain unverified.
