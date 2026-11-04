import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import {
  archiveName,
  lanAddresses,
  selectLanHost,
  caddyConfig,
  installCaddy,
} from "../src/lan/setup.js";
import { writeAdmin } from "../src/admin.js";
import { createClient } from "../src/apiClients.js";
test("LAN address selection permits only assigned private IPv4 addresses and safe ports", () => {
  const rows = lanAddresses({
    en0: [
      { address: "192.168.1.40", internal: false },
      { address: "::1", internal: true },
    ],
    utun0: [{ address: "10.1.1.1", internal: false }],
    pub: [{ address: "8.8.8.8", internal: false }],
  });
  assert.equal(rows[0].address, "192.168.1.40");
  assert.equal(selectLanHost(rows, "192.168.1.40"), "192.168.1.40");
  for (const ip of [
    "8.8.8.8",
    "127.0.0.1",
    "192.168.1.99",
    "https://192.168.1.40",
  ])
    assert.throws(() => selectLanHost(rows, ip));
  assert.throws(() => selectLanHost(rows));
  assert.throws(() => caddyConfig("192.168.1.40", 80, 3030, "/tmp/ca"));
  assert.throws(() => caddyConfig("192.168.1.40", 3030, 3030, "/tmp/ca"));
  const config = caddyConfig(
    "192.168.1.40",
    3443,
    3030,
    "/private/folder with spaces",
  );
  assert.match(config, /admin off/);
  assert.match(config, /skip_install_trust/);
  assert.match(config, /bind 192\.168\.1\.40/);
  assert.match(config, /reverse_proxy 127\.0\.0\.1:3030/);
  assert.match(archiveName("darwin", "arm64"), /_mac_arm64.tar.gz$/);
  assert.match(archiveName("win32", "x64"), /_windows_amd64.zip$/);
});
test("installer verifies official archive checksum before extraction and rejects tampering", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lan-install-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic release archive"),
    hash = createHash("sha512").update(bytes).digest("hex");
  let tamper = true,
    extracted = 0;
  const fetchImpl = async (url) =>
    new Response(
      url.endsWith("checksums.txt")
        ? `${hash}  ${archiveName("linux", "x64")}\n`
        : tamper
          ? Buffer.from("changed")
          : bytes,
    );
  const extract = async (file, args) => {
    extracted++;
    await fs.writeFile(path.join(args[3], "caddy"), "synthetic binary");
  };
  await assert.rejects(
    installCaddy(dir, { platform: "linux", arch: "x64", fetchImpl, extract }),
    /checksum mismatch/,
  );
  assert.equal(extracted, 0);
  tamper = false;
  const installed = await installCaddy(dir, {
    platform: "linux",
    arch: "x64",
    fetchImpl,
    extract,
  });
  assert.equal(await fs.readFile(installed, "utf8"), "synthetic binary");
});
async function freePort(host) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function request(url, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
  });
}
const host = lanAddresses()[0]?.address;
test(
  "real Caddy LAN launcher: HTTPS API, trusted CA, restart, unchanged env and managed shutdown",
  { skip: !process.env.TEST_CADDY || !host, timeout: 90000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lan-live-"));
    const data = path.join(dir, "runtime");
    await writeAdmin(data, "admin", "synthetic LAN administrator password");
    const client = await createClient(data, "test-client", ["read"]);
    const envFile =
      "CUSTOM_SETTING=preserve\nAUTH_REQUIRED=false\nPUBLIC_ORIGIN=http://127.0.0.1:3030\n";
    await fs.writeFile(path.join(dir, ".env"), envFile);
    const apiPort = await freePort("127.0.0.1"),
      tlsPort = await freePort(host);
    const origin = `https://${host}:${tlsPort}`;
    const app = fileURLToPath(new URL("../app.js", import.meta.url));
    let child,
      output = "";
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 18000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    };
    t.after(async () => {
      await stop();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const launch = () => {
      output = "";
      child = spawn(process.execPath, [app, "--lan"], {
        cwd: dir,
        env: {
          ...process.env,
          DATA_DIR: data,
          LAN_HOST: host,
          LAN_PORT: String(tlsPort),
          PORT: String(apiPort),
          AUTO_OPEN: "false",
          BROWSER_CONTAINER: "",
          CADDY_PATH: process.env.TEST_CADDY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
    };
    const ready = async () => {
      for (let n = 0; n < 150; n++) {
        if (output.includes("LAN READY")) return;
        if (child.exitCode !== null)
          throw new Error("LAN startup failed: " + output);
        await pause(200);
      }
      throw new Error("LAN readiness timed out: " + output);
    };
    launch();
    await ready();
    const certPath = path.join(data, "lan", "Studio-LAN-CA.crt"),
      ca = await fs.readFile(certPath);
    assert.equal((await request(origin + "/api/v1/health", ca)).status, 401);
    assert.equal(
      (
        await request(origin + "/api/v1/health", ca, {
          Authorization: "Bearer " + client.token,
        })
      ).status,
      200,
    );
    assert.equal((await request(origin + "/api/generation", ca)).status, 401);
    await assert.rejects(request(origin + "/api/v1/health", undefined));
    assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), envFile);
    assert.ok(!output.includes(client.token));
    await stop();
    assert.equal(child.exitCode, 0);
    launch();
    await ready();
    assert.ok((await fs.readFile(certPath)).equals(ca));
    assert.equal(
      (
        await request(origin + "/api/v1/health", ca, {
          Authorization: "Bearer " + client.token,
        })
      ).status,
      200,
    );
    await stop();
    assert.equal(child.exitCode, 0);
    // A competing listener must fail closed and release the internal API port.
    const occupied = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(tlsPort, host, resolve);
    });
    try {
      launch();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Failed startup did not exit: " + output)),
          20000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      assert.equal(child.exitCode, 1);
      const check = net.createServer();
      await new Promise((resolve, reject) => {
        check.once("error", reject);
        check.listen(apiPort, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => check.close(resolve));
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  },
);
