import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import sharp from "sharp";
import { startCompanion } from "../../companion/server.js";
import {
  serverOrigin,
  certificateInfo,
  remoteRequest,
} from "../../companion/transport.js";
import { readDownload, imageInfo } from "../../companion/files.js";
import { companionArchive } from "../../src/services/local/package.js";
test("loopback companion rejects foreign hosts/origins, protects mutations, and scopes extension pairing", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "companion-security-"),
  );
  const app = await startCompanion({
    port: 0,
    directory: folder,
    openBrowser: false,
  });
  try {
    const r = await fetch(app.url + "/api/state");
    const state = await r.json();
    assert(state.csrf);
    assert.equal(
      (
        await fetch(app.url + "/api/state", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.get(
        app.url + "/api/state",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal(
      (
        await fetch(app.url + "/api/extension-pair", {
          method: "POST",
          headers: { Origin: app.url, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    const response = await fetch(app.url + "/api/extension-pair", {
      method: "POST",
      headers: {
        Origin: app.url,
        "x-csrf-token": state.csrf,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const { code } = await response.json();
    const id = crypto.randomUUID(),
      extension = "a".repeat(32);
    const register = (origin, codeValue) =>
      fetch(app.url + "/bridge/register", {
        method: "POST",
        headers: {
          ...(origin ? { Origin: origin } : {}),
          "x-gemini-extension": extension,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id, label: "Chrome", code: codeValue }),
      });
    assert.equal((await register("https://evil.example", code)).status, 403);
    const paired = await register(null, code);
    assert.equal(paired.status, 200);
    const auth = await paired.json();
    assert(auth.token);
    assert.equal((await register(null, code)).status, 400);
    const exposed = JSON.stringify(
      await (await fetch(app.url + "/api/state")).json(),
    );
    assert(!exposed.includes(auth.token));
    assert(!exposed.includes("tokenHash"));
    assert.equal(
      (
        await fetch(app.url + "/bridge/heartbeat", {
          method: "POST",
          headers: {
            Origin: `chrome-extension://${extension}`,
            authorization: "Bearer wrong",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test("original download inspection checks dimensions and prevents traversal/symlink escapes", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "companion-files-")),
    downloads = path.join(folder, "Downloads");
  await fs.mkdir(downloads);
  const run = crypto.randomUUID();
  try {
    for (const format of ["png", "jpeg", "webp"]) {
      const b = await sharp({
        create: { width: 21, height: 19, channels: 3, background: "red" },
      })
        [format]()
        .toBuffer();
      assert.deepEqual(imageInfo(b), {
        width: 21,
        height: 19,
        format,
        bytes: b.length,
      });
    }
    const png = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const filename = path.join(downloads, `gemini-agent-${run}-1.png`);
    await fs.writeFile(filename, png);
    assert.deepEqual(await readDownload(downloads, filename, run), png);
    await assert.rejects(() =>
      readDownload(downloads, filename, crypto.randomUUID()),
    );
    await fs.writeFile(path.join(folder, "outside.png"), png);
    const symlink = path.join(downloads, `gemini-agent-${run}-escape.png`);
    await fs.symlink(path.join(folder, "outside.png"), symlink);
    await assert.rejects(() => readDownload(downloads, symlink, run));
    assert.throws(() => imageInfo(Buffer.from("<html>not an image</html>")));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test("VPS transport enforces trusted HTTPS and does not follow redirects", async () => {
  for (const value of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
  ])
    assert.throws(() => serverOrigin(value));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "companion-tls-"));
  let server;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(folder, "key.pem"),
        "-out",
        path.join(folder, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const ca = await fs.readFile(path.join(folder, "cert.pem"), "utf8");
    assert(certificateInfo(ca));
    server = https.createServer(
      { key: await fs.readFile(path.join(folder, "key.pem")), cert: ca },
      (req, res) => {
        if (req.url.endsWith("/redirect")) {
          res.writeHead(302, { Location: "https://evil.example" });
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        }
      },
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `https://localhost:${server.address().port}`;
    await assert.rejects(() =>
      remoteRequest({ origin }, "/api/companion/state"),
    );
    assert.equal(
      (await remoteRequest({ origin, ca }, "/api/companion/state")).data.ok,
      true,
    );
    await assert.rejects(() =>
      remoteRequest({ origin, ca }, "/api/companion/redirect"),
    );
    await assert.rejects(async () =>
      remoteRequest({ origin, ca }, "/api/auth/me"),
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test("downloadable ZIP starts with node app.js without npm packages or server secrets", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "companion-zip-"));
  let child;
  try {
    const zip = path.join(folder, "companion.zip");
    await fs.writeFile(zip, await companionArchive());
    execFileSync("unzip", ["-q", zip, "-d", path.join(folder, "app")]);
    const files = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" });
    assert(!files.includes(".env"));
    assert(!files.includes("node_modules"));
    assert(!files.includes("runtime/"));
    assert(files.includes("extension/manifest.json"));
    child = spawn(process.execPath, ["app.js"], {
      cwd: path.join(folder, "app"),
      env: {
        ...process.env,
        COMPANION_HOME: path.join(folder, "settings"),
        COMPANION_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise((resolve, reject) => {
      let log = "";
      const timeout = setTimeout(
        () => reject(new Error("Companion did not start")),
        10000,
      );
      child.stdout.on("data", (b) => {
        log += b.toString();
        const m = /http:\/\/127\.0\.0\.1:\d+/.exec(log);
        if (m) {
          clearTimeout(timeout);
          resolve(m[0]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Companion exited ${code}`));
      });
    });
    assert.equal((await fetch(url)).status, 200);
  } finally {
    if (child) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
    await fs.rm(folder, { recursive: true, force: true });
  }
});
