import { existsSync } from "node:fs";
import { configuration } from "./src/config.js";
import { startServer } from "./src/server.js";
if (existsSync(".env")) process.loadEnvFile(".env");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Node.js 22+ required");
process.umask(0o077);
const service = await startServer(configuration());
console.log(`Private VPS Browser listening on 127.0.0.1:${service.port}`);
console.log("Access:", service.config.origin);
if (!(await service.admin())) console.log("First run: npm run setup-admin");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const forced = setTimeout(() => process.exit(1), 15000);
    forced.unref();
    await service.close();
  });
