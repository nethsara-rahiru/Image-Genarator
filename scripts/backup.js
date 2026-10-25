import { spawn } from "node:child_process";
import path from "node:path";
import { configuration } from "../src/config/index.js";
const config = configuration();
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination))
  throw new Error("Usage: npm run backup -- /absolute/backup/directory");
const child = spawn(
  "bash",
  [
    new URL("./backup.sh", import.meta.url).pathname,
    config.DATA_DIR,
    destination,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, MONGODB_URI: config.MONGODB_URI },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
