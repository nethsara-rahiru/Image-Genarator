# Security

The default dashboard grants everyone who can reach it normal Chrome privileges under the host OS account without an application login, including managed HTTPS LAN mode. Optional AUTH_REQUIRED mode retains the legacy administrator boundary. The native Chrome address bar and file picker can access files/protocols available to that account; this is not an isolation boundary against the administrator. Prefer a dedicated local OS account. No personal Chrome profile, passwords or cookies are imported. The dedicated native-profile stays on the PC and uses Chrome's normal credential storage. No stealth patches, captcha/MFA workarounds, cookie transfer or browser security bypass are implemented.

Production uses installed desktop Chrome with its normal sandbox. Manual mode uses OS input/capture; automated Gemini uses a private stdio CDP connection, never a network debugging port. No headless or stealth configuration is used. Do not run as root or add --no-sandbox. Test-only sandbox relaxation exists only in trusted test constructor arguments; environment variables and API requests cannot enable it. Windows/macOS native permission prompts/policies require local approval; no global security-policy disabling is automated. Google sign-in may still fail; stop and follow the site's supported verification flow.

Frames are limited to the managed Chrome PID's window on Windows/macOS. Linux captures an isolated virtual display containing the managed Chrome environment, not the host's working desktop. No full-host-screen fallback is used. Windows/macOS input may change foreground focus/move the mouse. Keep the desktop unlocked and the window unminimized. Native dialogs or GPU/OS capture rules can prevent operation. macOS briefly writes a private frame file before deleting it; abrupt crashes can leave a residual private frame. Never share runtime or capture it in user-data test artifacts.

Node remains on loopback, and the managed LAN gateway provides HTTPS without a dashboard login. Exact Host/Origin and CSRF checks remain enforced. Optional protected mode uses Argon2id identity with confirmed hidden CLI password entry; bounded server-side sessions, HttpOnly/SameSite=Strict cookies, Secure cookies under HTTPS, CSRF for mutations, exact Host/Origin and authenticated WebSocket revocation. Sessions are checked before logs/frames, and reset invalidates prior identities. Restart invalidates session cookies. One process/one administrator; no shared multi-user isolation is promised. Login/input are rate-limited, and sensitive typed text is excluded from logs. Native helper requests use fixed operations and stdio JSON, not shell interpolation or arbitrary code evaluation.

Only the viewer and private native network proxy listen, both on loopback. X11 uses a private cookie and Unix socket, TCP disabled. No VNC, CDP or debugging listener is exposed. Remote access requires an encrypted authenticated SSH tunnel or trusted TLS proxy. On a busy PC, don't expose Node directly to LAN/public HTTP. Trust forwarded transport headers only from the loopback proxy. An optional VPS reverse tunnel carries viewer traffic only; website traffic remains on the PC.

The native browser network proxy validates all public DNS answers and pins the selected numeric address when connecting, including TLS CONNECT. Private/link-local/metadata, mapped/transition/reserved addresses and mixed DNS answers are blocked. TLS certificates are verified by Chrome normally; no HTTPS interception or certificate bypass is used. This is defense in depth, not a full OS network sandbox: external protocol handlers, native file dialogs and other OS applications need account/firewall isolation.

Profiles and directories use mode 700 and files mode 600 where supported; enforce Windows ACLs for equivalent privacy. Native Chrome can create its own files subject to OS defaults; protect the whole DATA_DIR. Downloads are authenticated attachments with nosniff, opaque IDs and symlink/path guards. Uploads are memory/size bounded and passed to a native chooser only. Native browser download temporary files can use unbounded disk before enumeration; use OS quotas. Logs are private/rotated and contain only safe event/action codes, IDs, timings and status categories, not query strings, typed text, credentials or page content. Chrome DevTools opens in the host's actual Chrome window and is not copied to log storage. Browser previews are not streamed.

The manual Google sign-in shortcut opens the official account chooser using
Chrome's normal URL invocation. The automated Gemini flow instead inspects
visible DOM state through its private pipe. Google can reject controlled browser
sessions; no bypass, security-policy relaxation or webdriver spoofing is used.

Background workspace: Docker Desktop/engine is a trusted local prerequisite.
Do not use a remote engine context or publish the container's port publicly.
The launcher publishes loopback only, runs as a non-root user with Chromium's
sandbox enabled, and passes only allowlisted non-secret settings. The included
seccomp policy permits Chromium sandbox namespaces without privileged mode.
The separate `DATA_DIR/background` contains authentication cookies and admin
hashes: protect it like the native profile. Its session/admin credentials do not
migrate from native mode. Never add .env, runtime data or personal profiles to
the image. Inspect Docker Desktop resource/file-sharing settings if binding this
private directory fails. Google credentials remain interactive in Google's
browser pages; logs contain static flow steps and sanitized errors, not inputs.

Google sign-in happens directly in Chrome. The dashboard has no Google credential
form; the flow rejects credential submissions and never invokes Groq for sign-in.
Only observed Gemini account/editor controls establish signed-in status. Browser
frames are not captured or streamed by the dashboard. Native capture helpers
remain available for diagnostics/tests but are not used by the viewer connection.

Legacy Groq settings remain server-side and are not used for manual sign-in.
Keys are never returned by settings APIs. No login screenshots, cookies, tokens
or credentials are sent to Groq.

Generation uses a process lease and serialized mutations. Browser/profile locks
still apply. A job owns the browser until it completes, fails or is cancelled;
manual actions and sign-in changes are blocked during that ownership. Input is
bounded and request keys are idempotent. A possible submission is durably marked
before Send; neither restart nor retry silently replays it.

Output paths are constructed from validated UUIDs and fixed PNG/JPEG/WebP names;
symlinks and paths escaping the output root are rejected. Downloads are tied to
the controlled frame and fresh response and checked for complete signatures,
actual dimensions, bytes and checksum. Header parsing is not image-content
analysis. Retention/deletion affects local data only. The journal and metadata
intentionally retain prompts; sanitized operational logs do not.

No-login mode is not a public service or a multi-user isolation boundary. Anyone
with access to the local PC or its SSH-forwarded interface can control the Google
session and read its jobs. Keep DATA_DIR private and use an encrypted trusted
SSH tunnel for remote use. HTTPS origins may use an open dashboard; bearer API ownership does not restrict
access through that shared dashboard. Existing Google authentication requirements and restrictions remain.
