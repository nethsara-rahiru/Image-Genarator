import { spawnSync } from "node:child_process";
import { chromeExecutable, findCommand } from "../src/native/common.js";
console.log(`Detected ${process.platform} (${process.arch}).`);
if (process.platform === "linux") {
  const packages = [
    "Xvfb",
    "xauth",
    "xdotool",
    "openbox",
    "import",
    "xprop",
    "dbus-daemon",
  ];
  const missing = [];
  for (const name of packages)
    if (!(await findCommand(name))) missing.push(name);
  if (missing.length) {
    console.log("Missing desktop packages:", missing.join(", "));
    const apt = await findCommand("apt-get");
    if (!apt) {
      console.log(
        "Install Xvfb, xauth, xdotool, Openbox, ImageMagick and xprop with your distribution package manager.",
      );
      process.exitCode = 1;
    } else {
      const root = process.getuid?.() === 0,
        command = root ? "apt-get" : "sudo";
      if (!root && !(await findCommand("sudo"))) {
        console.error(
          "An administrator must install: xvfb xauth xdotool openbox imagemagick x11-utils dbus-daemon",
        );
        process.exitCode = 1;
      } else {
        const args = [
          ...(root ? [] : ["apt-get"]),
          "install",
          "-y",
          "xvfb",
          "xauth",
          "xdotool",
          "openbox",
          "imagemagick",
          "x11-utils",
          "dbus-daemon",
        ];
        const result = spawnSync(command, args, { stdio: "inherit" });
        if (result.status !== 0) process.exitCode = 1;
      }
    }
  }
} else if (process.platform === "darwin")
  console.log(
    "On first use, allow Screen Recording, Accessibility and Automation for your terminal/Node in macOS System Settings.",
  );
else if (process.platform === "win32")
  console.log(
    "Use an unlocked Windows desktop. PowerShell runs the bundled window-only helper; application-control policies may require approval. Do not disable organizational policy.",
  );
else {
  console.error("Unsupported OS. Supported: Windows, macOS, Linux.");
  process.exitCode = 1;
}
try {
  await chromeExecutable(process.platform, process.env.CHROME_PATH);
  console.log("Desktop Chrome/Edge detected.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
