import { spawn } from "node:child_process";
import path from "node:path";
import mongoose from "mongoose";
import { configuration } from "./src/config/index.js";
import { connect } from "./src/models/index.js";
import { storage } from "./src/utils/files.js";
import { BrowserManager } from "./src/services/browserManager.js";
import { Worker } from "./src/workers/runner.js";
process.umask(0o077);
const config = configuration();
await storage(config);
if (!process.argv.includes("--lock-held")) {
  const child = spawn(
    "flock",
    [
      "--nonblock",
      "--no-fork",
      path.join(config.DATA_DIR, "worker.lock"),
      process.execPath,
      "--env-file-if-exists=.env",
      new URL(import.meta.url).pathname,
      "--lock-held",
    ],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    console.error("Ubuntu flock is required");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  await connect(config.MONGODB_URI);
  const worker = new Worker(config, new BrowserManager(config));
  await worker.start();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => worker.stop());
  let lastRetention = 0;
  try {
    while (!worker.stopped) {
      if (Date.now() - lastRetention > 3600000) {
        await worker.retention();
        lastRetention = Date.now();
      }
      const ran = await worker.tick();
      if (!ran) await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await worker.stop();
    await mongoose.disconnect();
  }
}
