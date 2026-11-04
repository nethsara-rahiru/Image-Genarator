import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { configuration } from "./src/config.js";
import { startServer } from "./src/server.js";
if (existsSync(".env")) process.loadEnvFile(".env");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Node.js 22+ required");
process.umask(0o077);
if (process.argv.includes("--lan")) {
  try {
    const { startLan } = await import("./scripts/lan.js");
    await startLan();
  } catch (error) {
    console.error(
      "LAN setup failed:",
      error.code === "EADDRINUSE"
        ? "Port already in use; stop the other app instance and retry."
        : error.code === "ELOCKED"
          ? "Another app or LAN setup owns this workspace. Stop it before retrying (an interrupted startup lock expires after 30 seconds)."
          : error.message,
    );
    process.exitCode = 1;
  }
} else if (process.argv.includes("--background")) {
  await import("./scripts/background.js");
} else {
  const config = configuration();
  console.log(
    `Detected ${process.platform} (${process.arch}); native desktop browser mode.`,
  );
  const service = await startServer(config);
  console.log(`Local Native Browser listening on 127.0.0.1:${service.port}`);
  console.log("Access:", service.config.origin);
  if (config.authRequired && !(await service.admin()))
    console.log("First run: npm run setup-admin");
  if (config.autoOpen) {
    const command =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", config.origin]
        : [config.origin];
    const opener = spawn(command, args, { stdio: "ignore", windowsHide: true });
    opener.on("error", () => {});
    opener.unref();
  }
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      const forced = setTimeout(() => process.exit(1), 15000);
      forced.unref();
      await service.close();
    });
}
