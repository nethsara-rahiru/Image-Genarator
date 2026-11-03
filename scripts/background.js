import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { configuration } from "../src/config.js";
import { readAdmin } from "../src/admin.js";
import { interactiveAdmin } from "./admin.js";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
process.umask(0o077);
const config = configuration();
const data = path.join(config.data, "background");
await fs.mkdir(data, { recursive: true, mode: 0o700 });
let child;
function docker(args, inherit = true) {
  return new Promise((resolve, reject) => {
    child = spawn("docker", args, {
      cwd: root,
      stdio: inherit ? "inherit" : "ignore",
      windowsHide: true,
    });
    child.once("error", () =>
      reject(
        new Error(
          "Docker is unavailable. Install and start Docker Desktop (Linux containers) on Windows/macOS, then retry.",
        ),
      ),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Docker command failed (${code}). Read the diagnostics above. No foreground browser fallback was started.`,
            ),
          ),
    );
  });
}
let release;
let stopping = false;
const name =
  "local-browser-" +
  createHash("sha256").update(data).digest("hex").slice(0, 16);
const cidfile = path.join(data, ".container-" + randomUUID());
const image = "local-native-browser-background:local";
try {
  await docker(["info", "--format", "Docker engine: {{.OSType}}"]);
  release = await lockfile.lock(data, {
    stale: 30000,
    update: 5000,
    retries: 0,
  });
  const adminConfig = { ...config, data };
  if (!(await readAdmin(data))) {
    if (!process.stdin.isTTY)
      throw new Error(
        "First background launch requires an interactive terminal to create its separate administrator.",
      );
    console.log(
      "Create the administrator for the isolated background workspace (separate from native mode).",
    );
    await interactiveAdmin(adminConfig);
    if (!(await readAdmin(data)))
      throw new Error("Administrator setup cancelled");
  }
  console.log(
    "Building the private Linux desktop image. First launch downloads system packages; later builds use the cache.",
  );
  const build = ["build", "-f", "container/Dockerfile", "-t", image];
  if (process.env.CODEX_PROXY_CERT)
    build.push("--secret", `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
  await docker([...build, "."]);
  console.log(
    `Open ${config.origin} after SERVICE_STARTED. Keep this terminal and Docker running. Ctrl+C stops the workspace; its profile stays saved.`,
  );
  const args = [
    "run",
    "--rm",
    "--cidfile",
    cidfile,
    "--init",
    "--name",
    name,
    "--label",
    "local-native-browser.background=true",
    "--shm-size=1g",
    "--tmpfs",
    "/tmp:rw,nosuid,mode=1777,size=1g",
    "--pids-limit=512",
    "--memory=4g",
    "--cpus=2",
    "--security-opt",
    `seccomp=${path.join(root, "container/seccomp.json")}`,
    "--publish",
    `127.0.0.1:${config.port}:3030`,
    "--mount",
    `type=bind,src=${data},dst=/data`,
    "--env",
    `PUBLIC_ORIGIN=${config.origin}`,
    "--env",
    `SESSION_HOURS=${config.sessionMs / 3600000}`,
    "--env",
    `BROWSER_IDLE_MINUTES=${config.idleMs / 60000}`,
  ];
  if (process.platform === "linux")
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  if (process.env.CODEX_PROXY_CERT)
    args.push(
      "--mount",
      `type=bind,src=${process.env.CODEX_PROXY_CERT},dst=/run/proxy-ca.pem,readonly`,
      "--env",
      "NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem",
    );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      // Docker only stops the fixed workspace container. Name conflicts are never removed automatically.
      let id;
      try {
        id = (await fs.readFile(cidfile, "utf8")).trim();
      } catch {
        return;
      }
      if (!/^[a-f0-9]{64}$/.test(id)) return;
      const stop = spawn("docker", ["stop", "--time", "15", id], {
        stdio: "ignore",
        windowsHide: true,
      });
      stop.on("error", () => {});
    });
  await docker([...args, image]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await fs.rm(cidfile, { force: true }).catch(() => {});
  await release?.().catch(() => {});
}
