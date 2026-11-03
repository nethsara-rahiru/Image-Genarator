# Background workspace

This image runs the normal app and headed Chromium on a private Xvfb desktop.
Only the authenticated dashboard is published, on host loopback. There are no
VNC, CDP or X11 network listeners. Native host screen capture/input is unused.
Docker Desktop with Linux containers is required on macOS/Windows; a local Docker
engine is required on Linux. Use a local engine, not a remote Docker context.

`seccomp.json` comes from Microsoft Playwright v1.56.0,
https://github.com/microsoft/playwright/blob/v1.56.0/utils/docker/seccomp_profile.json
(Apache-2.0, upstream LICENSE at https://github.com/microsoft/playwright/blob/v1.56.0/LICENSE).
It extends the standard Docker syscall policy for Chromium's user-namespace
sandbox. Playwright is not installed or used in the production image.

The launcher never uses privileged mode, host networking or `--no-sandbox`.
The host kernel/VM must allow unprivileged user namespaces. If Chromium reports
`BROWSER_SANDBOX`, stop and inspect the engine/OS security policy; the launcher
will not weaken it. Docker Desktop launch on a physical Mac/Windows PC and live
Google authentication require user validation. A container does not guarantee
that Google will accept sign-in.
