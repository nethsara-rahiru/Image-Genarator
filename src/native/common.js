import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
export class NativeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeError";
    this.code = code;
  }
}
export const nativeError = (code, message) => new NativeError(code, message);
export async function executable(file) {
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}
export async function findCommand(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter))
    for (const suffix of process.platform === "win32"
      ? [".exe", ".cmd", ""]
      : [""]) {
      const found = await executable(path.join(dir, name + suffix));
      if (found) return found;
    }
  return null;
}
export async function chromeExecutable(
  platform = process.platform,
  override = "",
) {
  if (!["win32", "darwin", "linux"].includes(platform))
    throw nativeError(
      "OS_UNSUPPORTED",
      "Supported host operating systems are Windows, macOS and Linux.",
    );
  if (override) {
    const found = await executable(override);
    if (!found)
      throw nativeError(
        "CHROME_NOT_INSTALLED",
        "CHROME_PATH does not point to an installed browser executable.",
      );
    return found;
  }
  let candidates = [];
  if (platform === "win32")
    candidates = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .flatMap((dir) => [
        path.join(dir, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe"),
      ]);
  else if (platform === "darwin")
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  else if (platform === "linux")
    for (const name of [
      "google-chrome-stable",
      "google-chrome",
      "chromium",
      "chromium-browser",
    ]) {
      const found = await findCommand(name);
      if (found) return found;
    }
  else
    throw nativeError(
      "OS_UNSUPPORTED",
      "Supported host operating systems are Windows, macOS and Linux.",
    );
  for (const file of candidates) {
    const found = await executable(file);
    if (found) return found;
  }
  throw nativeError(
    "CHROME_NOT_INSTALLED",
    "Install desktop Google Chrome or Microsoft Edge, or set CHROME_PATH. No automated Chromium download is used.",
  );
}
export function run(
  command,
  args = [],
  { input, env, timeout = 12000, maxBytes = 16 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false,
      size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        nativeError(
          "NATIVE_TIMEOUT",
          "The native desktop operation timed out. Check desktop permissions and whether the PC is unlocked.",
        ),
      );
    }, timeout);
    child.on("error", () =>
      finish(
        nativeError(
          "NATIVE_HELPER_MISSING",
          "A required operating-system helper could not be started. Run npm run doctor.",
        ),
      ),
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill();
        finish(
          nativeError(
            "FRAME_TOO_LARGE",
            "The browser frame exceeded its size limit. Resize the Chrome window.",
          ),
        );
      } else chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) =>
      code === 0
        ? finish(null, Buffer.concat(chunks))
        : finish(
            nativeError(
              "DESKTOP_PERMISSION_REQUIRED",
              "Native desktop capture/control failed. Check OS permissions, desktop availability and installed helpers with npm run doctor.",
            ),
          ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function terminate(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode)
    return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else child.kill("SIGKILL");
  }, 3000);
  timer.unref();
  await done;
  clearTimeout(timer);
}
export function jpegDimensions(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw nativeError(
      "FRAME_INVALID",
      "The native helper did not return a JPEG frame.",
    );
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i++] !== 255) continue;
    const marker = bytes[i++];
    if (marker === 216 || marker === 217) continue;
    const size = bytes.readUInt16BE(i);
    if (size < 2) break;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    )
      return {
        height: bytes.readUInt16BE(i + 3),
        width: bytes.readUInt16BE(i + 5),
      };
    i += size;
  }
  throw nativeError("FRAME_INVALID", "JPEG dimensions could not be read.");
}
export function browserArguments(
  profile,
  proxyPort,
  { test = false, homepage = "https://www.google.com/" } = {},
) {
  const args = [
    `--user-data-dir=${profile}`,
    "--new-window",
    "--no-first-run",
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--window-size=1280,900",
  ];
  // Trusted test injection only; never enabled by an environment variable or an API request.
  if (test) args.push("--no-sandbox");
  args.push(homepage);
  return args;
}
export function validKey(key) {
  const parts = String(key).split("+"),
    last = parts.pop();
  return (
    parts.every((p) => ["Control", "Meta", "Alt", "Shift"].includes(p)) &&
    (/^[a-zA-Z0-9]$/.test(last) ||
      [
        "Enter",
        "Tab",
        "Backspace",
        "Delete",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space",
        "F5",
      ].includes(last))
  );
}
export function launchFailure(output = "") {
  if (
    /No usable sandbox|sandboxing failed|Failed to move to new namespace|apparmor/i.test(
      output,
    )
  )
    return nativeError(
      "BROWSER_SANDBOX",
      "Desktop Chrome sandbox startup failed. Use a supported installed Chrome package and configure host sandbox permissions; do not disable sandboxing.",
    );
  if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(output))
    return nativeError(
      "BROWSER_PROFILE_BUSY",
      "The dedicated Chrome profile is already in use. Close that managed browser before retrying.",
    );
  if (
    /error while loading shared libraries|cannot open shared object/i.test(
      output,
    )
  )
    return nativeError(
      "BROWSER_DEPENDENCIES",
      "Desktop Chrome system libraries are missing. Install the supported Chrome package and run npm run setup-host.",
    );
  return nativeError(
    "CHROME_START_FAILED",
    "Chrome exited before its window became available. Run npm run doctor -- --launch to check a fresh native window.",
  );
}
