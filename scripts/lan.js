import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { configuration } from "../src/config.js";
import { startServer } from "../src/server.js";
import { readAdmin } from "../src/admin.js";
import { interactiveAdmin } from "./admin.js";
import { createClient, readClients } from "../src/apiClients.js";
import {
  lanAddresses,
  selectLanHost,
  caddyConfig,
  ensureCaddy,
} from "../src/lan/setup.js";
async function chooseHost(rows, saved) {
  const explicit = process.env.LAN_HOST;
  if (explicit) return selectLanHost(rows, explicit);
  const previous = rows.find((row) => row.address === saved);
  if (previous || rows.length === 1)
    return previous?.address || rows[0].address;
  if (!process.stdin.isTTY || !rows.length) return selectLanHost(rows);
  console.log(
    "Choose this PC's Wi-Fi/Ethernet address (both PCs must share this network):",
  );
  rows.forEach((row, index) =>
    console.log(`  ${index + 1}. ${row.name}: ${row.address}`),
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question("Address number: ");
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !rows[index])
      throw new Error("Invalid address selection; run --lan again");
    return selectLanHost(rows, rows[index].address);
  } finally {
    rl.close();
  }
}
async function probe(origin, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      origin + "/api/v1/health",
      { ca, timeout: 1500 },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 401
            ? resolve()
            : reject(new Error("Unexpected API readiness response")),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error("HTTPS readiness timed out")),
    );
  });
}
export async function startLan() {
  if (process.argv.includes("--background"))
    throw new Error(
      "Use --lan in native desktop mode. Docker --background cannot be combined with --lan.",
    );
  const data = path.resolve(process.env.DATA_DIR || "./runtime");
  const dir = path.join(data, "lan");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const release = await lockfile.lock(dir, {
    stale: 30000,
    update: 5000,
    retries: 0,
  });
  let service,
    child,
    stopping = false,
    closing;
  const close = () => {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      if (child && child.exitCode === null && !child.signalCode) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
      if (service) await service.close();
      await release();
      for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, shutdown);
    })();
    return closing;
  };
  const shutdown = () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  };
  try {
    let saved = {};
    try {
      saved = JSON.parse(
        await fs.readFile(path.join(dir, "settings.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const host = await chooseHost(lanAddresses(), saved.host);
    const tlsPort = Number(process.env.LAN_PORT || saved.port || 3443);
    const origin = `https://${host}:${tlsPort}`;
    const config = configuration({
      ...process.env,
      DATA_DIR: data,
      PUBLIC_ORIGIN: origin,
      AUTH_REQUIRED: "true",
      AUTO_OPEN: "false",
    });
    const storage = path.join(dir, "pki");
    const contents = caddyConfig(host, tlsPort, config.port, storage);
    console.log(
      `LAN HTTPS setup: ${origin}\nDashboard authentication is required; your .env is unchanged.`,
    );
    if (!(await readAdmin(data))) {
      if (!process.stdin.isTTY)
        throw new Error(
          "First run requires a terminal for administrator setup. Run npm run setup-admin, then node app.js --lan.",
        );
      await interactiveAdmin(config);
      if (!(await readAdmin(data)))
        throw new Error(
          "Administrator setup was not completed. No LAN listener was started.",
        );
    }
    if (stopping) return;
    const caddy = await ensureCaddy(dir, process.env.CADDY_PATH);
    if (stopping) return;
    const configFile = path.join(dir, "Caddyfile");
    await fs.writeFile(configFile, contents, { mode: 0o600 });
    service = await startServer(config);
    if (stopping) {
      await service.close();
      return;
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
    child = spawn(
      caddy,
      ["run", "--config", configFile, "--adapter", "caddyfile"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let failure;
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", () => {
      failure = new Error("Could not start Caddy HTTPS gateway");
      shutdown();
    });
    child.on("exit", (code, signal) => {
      if (!stopping) {
        failure = new Error(
          `HTTPS gateway stopped (${code ?? signal}). Check the port, firewall and Caddy messages above.`,
        );
        console.error(failure.message);
        process.exitCode = 1;
        shutdown();
      }
    });
    const root = path.join(storage, "pki", "authorities", "local", "root.crt");
    let ca;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !stopping) {
      if (failure) throw failure;
      try {
        ca = await fs.readFile(root);
        await probe(origin, ca);
        break;
      } catch {
        ca = null;
        await pause(250);
      }
    }
    if (!ca || stopping)
      throw (
        failure ||
        new Error(
          "LAN HTTPS could not become ready. Stop other app/Caddy instances, confirm the LAN IP and port, then retry.",
        )
      );
    const certificate = path.join(dir, "Studio-LAN-CA.crt");
    await fs.writeFile(certificate, ca, { mode: 0o600 });
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ host, port: tlsPort }),
      { mode: 0o600 },
    );
    console.log(
      `\nLAN READY\nDashboard: ${origin}\nPostman API base: ${origin}/api/v1\nPublic CA certificate: ${certificate}\nSHA-256 certificate fingerprint: ${new X509Certificate(ca).fingerprint256}\n\nOn the second PC: Postman → Settings → Certificates → CA Certificates → import Studio-LAN-CA.crt. Keep SSL verification enabled. Copy ONLY this .crt, never private keys.\nAllow incoming connections for Caddy if the OS firewall asks. Keep this terminal open; Ctrl+C stops both services.\n`,
    );
    const active = (await readClients(data)).some(
      (client) => !client.revoked && Date.parse(client.expiresAt) > Date.now(),
    );
    if (!active && process.stdin.isTTY && process.stdout.isTTY) {
      const client = await createClient(data, "LAN Postman", [
        "read",
        "generate",
        "browser",
      ]);
      console.log(
        `First Postman bearer token (shown once): ${client.token}\nClient ID: ${client.id}\nStore the token securely; do not share it in chat.`,
      );
    } else
      console.log(
        'Use an existing API token, or create one in another terminal: npm run api-client -- create "postman" read,generate,browser 90',
      );
    return { origin, certificate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
