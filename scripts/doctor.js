import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configuration } from "../src/config.js";
import { browserStartupError } from "../src/browserErrors.js";
process.umask(0o077);
const config = configuration();
console.log(
  `Node ${process.versions.node}; ${process.platform} ${os.release()}; UID ${process.getuid?.() ?? "unavailable"}`,
);
console.log(
  "Checking Chromium without opening any website or using your saved profile.",
);
let scratch, context;
try {
  if (process.getuid?.() === 0)
    throw new Error("Run as a non-root service user, not sudo/root");
  await fs.access(chromium.executablePath());
  console.log("Chromium executable exists.");
  await fs.mkdir(config.data, { recursive: true, mode: 0o700 });
  scratch = await fs.mkdtemp(path.join(config.data, "doctor-"));
  context = await chromium.launchPersistentContext(scratch, {
    headless: true,
    chromiumSandbox: true,
    timeout: 20000,
  });
  console.log("PASS: isolated Chromium profile starts with sandbox enabled.");
  console.log(
    "If the app still fails, check PM2 runs as this same user, DATA_DIR/profile permissions and duplicate app instances.",
  );
} catch (error) {
  const diagnosis = browserStartupError(error);
  console.error(`${diagnosis.code}: ${diagnosis.message}`);
  // Fresh-profile startup only: no visited URLs, website credentials, cookies or .env values.
  if (error.code === "ENOENT")
    console.error(
      "Chromium executable is missing. Run npx playwright install --with-deps chromium.",
    );
  else console.error(String(error.message).slice(0, 8000));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
}
