# Local native architecture

One Node.js process serves the authenticated vanilla viewer, admin APIs, logs and WebSockets on loopback. NativeBrowser detects process.platform and launches installed desktop Chrome/Edge with a dedicated native-profile. No production Playwright is used. Manual mode uses OS control; automated Gemini adds a private stdio CDP pipe, never a network debugging listener. The existing Argon2id CLI identity, CSRF/session revocation, Host/Origin checks, bounded input queue and JSONL log journal remain.

Windows uses a persistent PowerShell helper with a compiled C# User32 window-capture/input implementation. Requests are validated fixed JSON commands over stdio; typed text is not placed in command-line arguments. Window selection is restricted to the managed Chrome PID; PrintWindow has no full-desktop fallback. Input focuses only an owned window and verifies foreground ownership. The OS may reject capture/input due to locking, permissions or policy.

macOS executes a fixed JXA helper with JSON on stdin, uses CoreGraphics to select a window owned by the managed PID and System Events/CoreGraphics for input, and screencapture -l for a specific window. OS Screen Recording/Accessibility/Automation permissions are required. The temporary capture is kept private and removed after use; abrupt process termination can leave that one private file to clean up. No whole-screen fallback is used.

Linux starts Xvfb with a random MIT-MAGIC-COOKIE, a private Xauthority file and TCP disabled, then a private D-Bus session, Openbox and Chrome. xdotool controls only that private display; ImageMagick captures it in memory. No VNC daemon or publicly accessible browser/debug port exists. A proper-lockfile lease protects the dedicated profile, and the recorded Chrome PID prevents startup over an orphan managed browser. Shutdown closes only the managed process/display/helpers.

A local HTTP CONNECT proxy validates all DNS answers, refuses private/reserved/metadata targets and pins an approved address to the TCP connection, preventing a second resolver lookup at connect time. TLS remains end-to-end in Chrome; the proxy does not decrypt site traffic or inspect HTTPS response/page content. Chrome uses that proxy with implicit loopback bypass disabled; non-proxied WebRTC UDP is disabled. External OS protocols and local file access are outside this network proxy; this is a trusted-administrator normal-browser session, not a browser sandbox against its administrator. OS firewall/account isolation remain necessary for untrusted browsing.

Native input commands are serialized; frame streaming has backpressure and session checks. The viewer renders actual frame dimensions, including native Chrome tabs and dialogs. Navigation/search uses Chrome’s normal URL invocation to open a new tab without simulated omnibox typing; no DOM/load-completion claim is made. Google search URLs are deterministic and network-validated. DevTools is opened via a native key chord, not a debugging API.

Chrome preferences for this dedicated profile point downloads to private app storage. Downloads are enumerated from disk with opaque IDs; partial/hidden/symlink/oversized entries are excluded and newest 100 retained. Uploads are saved with randomized private names and passed only into a verified native chooser, newest bounded set retained. No file content analysis occurs. Files/profiles/logs are never committed.

## Guided Gemini flow and isolated background workspace

`GeminiFlow` opens Gemini first through a private browser-control pipe. Fixed
local DOM code classifies signed-in account/editor controls, signed-out controls,
recognized Google input fields, security checks and unknown states. Only booleans,
step kinds and allowlisted button IDs/categories leave the reader. The control
pipe is enabled only for the automated flow; starting it can restart the manual
browser while retaining its dedicated profile. No debugging TCP port is opened.

Observed signed-in Gemini ends automation immediately. Signed-out Gemini leads
to Google and a token-bound, one-field-at-a-time credential dialog. A fixed local
function checks exact origin and visible input kind, fills it and submits a
verified Next button once. Stale tokens and changed fields are rejected. Ambiguous
results become needs_review. Security checks require human intervention. Input
values are never placed in flow snapshots or logs. A fresh Check again observes
the page; it never replays previous credentials.

GroqRecovery runs only on unknown steps, at most twice per flow. Its payload is
a fresh projection of enum-valued navigation candidates; page text, screenshots,
URLs, cookies, account identity and credentials are excluded. Strict JSON
validation permits click/wait/ask_user only. Click targets are revalidated by the
local reader and subsequent page state is observed. Model code/URLs/selectors
are never executed. Settings/key are server-side in private groq.json; API
responses expose only configured/model/usage, not the key.

Authenticated APIs return promptly for automation/input. WebSocket messages
replay flow steps after reconnect. Flow state is in memory; sanitized events and
Chrome profile persist. After restart begin a new observation using that profile.

`node app.js --background` builds the production-only Linux image and publishes
its dashboard on host loopback. The container runs the same application with
private Xvfb/OS input, a separate bind-mounted data directory, resource limits,
and Chromium sandboxing. Only in this container does the server listen on
0.0.0.0; the Docker host publication is explicitly 127.0.0.1. Windows/macOS host
native capture/input is unused in this mode. Build context uses an explicit
source allowlist. Signals stop only the container ID created by this launch;
existing containers or profiles are not silently deleted on conflict.

## Local no-login generation worker

The default configuration now opens the local workspace without an administrator
identity. Sessions remain for CSRF/transport safeguards. Public no-login origins
are rejected; opt-in AUTH_REQUIRED preserves legacy protected access. Browser
profiles and old admin files are preserved. Startup and Docker launch no longer
prompt for an app password. This is a trusted shared local workspace.

GenerationQueue owns a leased journal under DATA_DIR/generation and executes one
job at a time inside the API process. Mutations are serialized and the journal is
written to a private temporary file then renamed atomically. FIFO uses monotonic
sequence; an explicit safe retry moves to the tail. Potential submission is
persisted before clicking Send. Interrupted submitted jobs require review, never
automatic replay. Shutdown cancels the wait/download and releases ownership.

GenerationRunner uses fixed local code through the existing private browser pipe.
It opens a fresh or saved Gemini chat, verifies account identity using a local
hash of the visible account label, records response/image baselines, fills the
composer, submits once and observes the new response. Historical image-source
fingerprints and response IDs protect association even if old DOM nodes rerender.
Only the first valid image in the latest new response can be selected. Unknown
controls or ambiguous submission/download state fail safely; there is no model
code execution, output screenshot or image-content analysis.

A frame-bound Browser.downloadWillBegin/downloadProgress pair identifies the
website's original download. Chrome temporarily saves by its GUID into the job's
private directory; normal download behavior is restored afterwards. Unfinished
or oversized downloads are cancelled. File signatures, actual dimensions, size
and checksum are inspected; original bytes and metadata JSON are retained. The
real chat ID is read from Gemini's conversation URL and stored in the local
catalog, including failed jobs where a conversation was observed.
