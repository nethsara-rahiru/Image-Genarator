import { DesktopDriver } from "../src/native/desktop.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { RemoteBrowser } from "../src/browser.js";
import { configuration } from "../src/config.js";
import { chromeExecutable, findCommand } from "../src/native/common.js";
import { readAdmin } from "../src/admin.js";
const config = configuration();
console.log(
  `OS: ${process.platform}; architecture: ${process.arch}; Node: ${process.versions.node}`,
);
console.log(
  "Native desktop mode. No headless/browser-automation connection is used.",
);
let failed = false;
try {
  await chromeExecutable(process.platform, config.chromePath);
  console.log("PASS: installed desktop Chrome/Edge executable found.");
} catch (error) {
  console.error(error.code + ": " + error.message);
  failed = true;
}
if (process.platform === "linux")
  for (const command of [
    "Xvfb",
    "xauth",
    "xdotool",
    "openbox",
    "import",
    "xprop",
    "dbus-daemon",
  ]) {
    if (await findCommand(command)) console.log("PASS: " + command);
    else {
      console.error("MISSING: " + command);
      failed = true;
    }
  }
if (process.getuid?.() === 0) {
  console.error("Run as a normal non-root OS user.");
  failed = true;
}
if (process.platform === "win32")
  console.log(
    "Check that the PC is unlocked, the managed Chrome window is visible, and PowerShell permits the trusted bundled helper. No desktop screenshot is taken by this diagnostic.",
  );
if (process.platform === "darwin")
  console.log(
    "Check Screen Recording, Accessibility and Automation permissions for the terminal/Node. Grant permissions locally; the app cannot bypass them. No desktop screenshot is taken by this diagnostic.",
  );
if (process.platform === "darwin") {
  try {
    const driver = new DesktopDriver(
      "darwin",
      path.join(config.data, "native"),
    );
    let managedPid = 0;
    try {
      const record = JSON.parse(
        await fs.readFile(
          path.join(config.data, "native", "browser.json"),
          "utf8",
        ),
      );
      if (Number.isSafeInteger(record.pid) && record.pid > 0) {
        process.kill(record.pid, 0);
        managedPid = record.pid;
      }
    } catch {}
    driver.setProcess(managedPid);
    const result = await driver.diagnostics();
    const status = (value) =>
      value === true
        ? "granted"
        : value === false
          ? "not granted"
          : "preflight unavailable";
    console.log(
      "macOS Screen Recording preflight: " +
        status(result.permissions.screenRecording),
    );
    console.log(
      "macOS Accessibility preflight: " +
        status(result.permissions.accessibility),
    );
    console.log("macOS window query: " + result.windowQuery);
    console.log(
      managedPid
        ? "Visible windows for managed Chrome: " + result.visibleManagedWindows
        : "No running managed Chrome record in this DATA_DIR; start it to check visible-window ownership.",
    );
    console.log(
      "Automation is checked when controlling System Events; MAC_AUTOMATION_REQUIRED identifies a denied request.",
    );
  } catch (error) {
    console.error(error.code || "MAC_NATIVE_FAILED", error.message);
    failed = true;
  }
}
console.log(
  (await readAdmin(config.data))
    ? "Administrator exists."
    : "First run: node app.js in an interactive terminal or npm run setup-admin.",
);
if (failed) process.exitCode = 1;

if (!failed && process.argv.includes("--launch")) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "native-doctor-"));
  const browser = new RemoteBrowser(
    { ...config, data },
    {
      homepage: "about:blank",
      proxyOptions: {
        validate: async () => {
          throw new Error("Diagnostic network disabled");
        },
      },
    },
  );
  try {
    await browser.start();
    await browser.capture();
    console.log(
      "PASS: fresh native window starts and window capture succeeds. No website or saved profile was opened.",
    );
  } catch (error) {
    console.error(error.code || "NATIVE_FAILED", error.message);
    process.exitCode = 1;
  } finally {
    await browser.stop();
    await fs.rm(data, { recursive: true, force: true });
  }
}
