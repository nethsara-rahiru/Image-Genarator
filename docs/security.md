# Security

The app grants its single authenticated administrator normal Chrome privileges under the host OS account. The native Chrome address bar and file picker can access files/protocols available to that account; this is not an isolation boundary against the administrator. Prefer a dedicated local OS account. No personal Chrome profile, passwords or cookies are imported. The dedicated native-profile stays on the PC and uses Chrome's normal credential storage. No stealth patches, captcha/MFA workarounds, cookie transfer or browser security bypass are implemented.

Production uses installed desktop Chrome with its normal sandbox. Manual mode uses OS input/capture; automated Gemini uses a private stdio CDP connection, never a network debugging port. No headless or stealth configuration is used. Do not run as root or add --no-sandbox. Test-only sandbox relaxation exists only in trusted test constructor arguments; environment variables and API requests cannot enable it. Windows/macOS native permission prompts/policies require local approval; no global security-policy disabling is automated. Google sign-in may still fail; stop and follow the site's supported verification flow.

Frames are limited to the managed Chrome PID's window on Windows/macOS. Linux captures an isolated virtual display containing the managed Chrome environment, not the host's working desktop. No full-host-screen fallback is used. Windows/macOS input may change foreground focus/move the mouse. Keep the desktop unlocked and the window unminimized. Native dialogs or GPU/OS capture rules can prevent operation. macOS briefly writes a private frame file before deleting it; abrupt crashes can leave a residual private frame. Never share runtime or capture it in user-data test artifacts.

Argon2id identity with confirmed hidden CLI password entry; bounded server-side sessions, HttpOnly/SameSite=Strict cookies, Secure cookies under HTTPS, CSRF for mutations, exact Host/Origin and authenticated WebSocket revocation. Sessions are checked before logs/frames, and reset invalidates prior identities. Restart invalidates session cookies. One process/one administrator; no shared multi-user isolation is promised. Login/input are rate-limited, and sensitive typed text is excluded from logs. Native helper requests use fixed operations and stdio JSON, not shell interpolation or arbitrary code evaluation.

Only the viewer and private native network proxy listen, both on loopback. X11 uses a private cookie and Unix socket, TCP disabled. No VNC, CDP or debugging listener is exposed. Remote access requires an encrypted authenticated SSH tunnel or trusted TLS proxy. On a busy PC, don't expose Node directly to LAN/public HTTP. Trust forwarded transport headers only from the loopback proxy. An optional VPS reverse tunnel carries viewer traffic only; website traffic remains on the PC.

The native browser network proxy validates all public DNS answers and pins the selected numeric address when connecting, including TLS CONNECT. Private/link-local/metadata, mapped/transition/reserved addresses and mixed DNS answers are blocked. TLS certificates are verified by Chrome normally; no HTTPS interception or certificate bypass is used. This is defense in depth, not a full OS network sandbox: external protocol handlers, native file dialogs and other OS applications need account/firewall isolation.

Profiles and directories use mode 700 and files mode 600 where supported; enforce Windows ACLs for equivalent privacy. Native Chrome can create its own files subject to OS defaults; protect the whole DATA_DIR. Downloads are authenticated attachments with nosniff, opaque IDs and symlink/path guards. Uploads are memory/size bounded and passed to a native chooser only. Native browser download temporary files can use unbounded disk before enumeration; use OS quotas. Logs are private/rotated and contain only safe event/action codes, IDs, timings and status categories, not query strings, typed text, credentials or page content. Chrome DevTools is visible only in the administrator's stream and is not copied to log storage.

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

The automated sign-in dialog collects only the current recognized Google field.
Its ID/token binds it to the active flow step, and credentials are never saved
in settings, logs, flow state or API responses. The reader checks exact allowed
origin and input type/name locally before filling. Next is submitted once;
ambiguous outcomes pause for review. Security checks require user participation.
Password/code fields are masked, and values clear before request, on cancel,
logout, disconnection and page exit. Request/process memory contains the value
briefly; no claim of secure memory erasure or browser password-manager control is
made. Google and Chrome may separately retain sessions/passwords as configured.

Groq receives only fresh, allowlisted navigation candidate IDs/categories. Never
send login screenshots, raw page text, URLs, account labels, credential values,
cookies or tokens. Model output is schema-checked; only a supplied safe click,
wait or ask_user is accepted. Fixed local code rechecks the target/site; model
JavaScript, shell, arbitrary navigation and credential operations are prohibited.
API settings hide the Groq key and store it with mode 600 in the private data
directory. Existing CSRF/auth/session/transport checks protect settings and input.
