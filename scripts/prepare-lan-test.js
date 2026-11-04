import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installCaddy, command } from "../src/lan/setup.js";
const dir = await fs.mkdtemp(
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), "studio-caddy-test-"),
);
const binary = await installCaddy(dir);
console.log(await command(binary, ["version"]));
if (process.env.GITHUB_ENV)
  await fs.appendFile(process.env.GITHUB_ENV, `TEST_CADDY=${binary}\n`);
else console.log(`Run LAN integration with TEST_CADDY=${binary}`);
