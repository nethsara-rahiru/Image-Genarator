import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serverOrigin, certificateInfo, remoteRequest } from "./transport.js";
import { BrowserBroker } from "./broker.js";
import { LocalAgent } from "./agent.js";
const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
async function jsonBody(req, limit = 1000000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request exceeds size limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
const json = (res, data, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
};
export async function startCompanion({
  port = Number(process.env.COMPANION_PORT || 4317),
  directory = process.env.COMPANION_HOME ||
    path.join(os.homedir(), ".gemini-agent-companion"),
  openBrowser = true,
  request = remoteRequest,
} = {}) {
  process.umask(0o077);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "config.json");
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error(
        "Companion configuration is unreadable; restore it before starting",
      );
    settings = {
      browsers: [],
      downloadRoot: path.join(os.homedir(), "Downloads"),
    };
  }
  let saving = Promise.resolve();
  const save = () => {
    saving = saving
      .catch(() => {})
      .then(async () => {
        const temp = filename + ".tmp";
        await fs.writeFile(temp, JSON.stringify(settings, null, 2), {
          mode: 0o600,
        });
        await fs.rename(temp, filename);
      });
    return saving;
  };
  const csrf = crypto.randomBytes(32).toString("hex");
  const broker = new BrowserBroker(settings, save);
  const listeners = new Set();
  const notify = (type, data) => {
    for (const response of listeners)
      if (!response.destroyed)
        response.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  const agent = new LocalAgent(settings, save, broker, notify, { request });
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) {
        json(res, { error: "Unexpected local host" }, 403);
        return;
      }
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'",
      );
      const url = new URL(req.url, origin);
      const extensionId = req.headers["x-gemini-extension"];
      const bridgeOrigin =
        req.headers.origin ||
        (/^[a-p]{32}$/.test(extensionId || "")
          ? `chrome-extension://${extensionId}`
          : "");
      const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(
        bridgeOrigin,
      );
      if (url.pathname.startsWith("/bridge/")) {
        if (!extensionOrigin) {
          json(res, { error: "Extension origin required" }, 403);
          return;
        }
        res.setHeader("access-control-allow-origin", bridgeOrigin);
        res.setHeader("vary", "Origin");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET,POST",
            "access-control-allow-headers":
              "authorization,content-type,x-gemini-extension",
          });
          res.end();
          return;
        }
        if (url.pathname === "/bridge/register" && req.method === "POST") {
          json(res, await broker.register(await jsonBody(req), bridgeOrigin));
          return;
        }
        let browser;
        try {
          browser = broker.authorize(req, bridgeOrigin);
        } catch {
          json(res, { error: "Extension authorization failed" }, 401);
          return;
        }
        if (url.pathname === "/bridge/stream" && req.method === "GET") {
          broker.attach(browser, res);
          return;
        }
        const d = await jsonBody(req);
        if (url.pathname === "/bridge/heartbeat") {
          broker.heartbeat(browser.id);
          json(res, { ok: true });
          return;
        }
        if (url.pathname === "/bridge/result") {
          broker.result(browser.id, d);
          json(res, { ok: true });
          return;
        }
        if (url.pathname === "/bridge/action") {
          json(res, await agent.action(browser.id, d));
          return;
        }
        json(res, { error: "Unknown bridge action" }, 404);
        return;
      }
      if (req.headers.origin && req.headers.origin !== origin) {
        json(res, { error: "Local origin required" }, 403);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          req.method !== "GET" &&
          (req.headers["x-csrf-token"] !== csrf ||
            req.headers.origin !== origin)
        ) {
          json(res, { error: "Invalid local request token" }, 403);
          return;
        }
        if (url.pathname === "/api/state" && req.method === "GET") {
          json(res, {
            ...agent.summary(),
            csrf,
            extensionDirectory: path.resolve(publicRoot, "../../extension"),
            caFingerprint: settings.ca ? certificateInfo(settings.ca) : null,
          });
          return;
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          res.write(": connected\n\n");
          listeners.add(res);
          req.on("close", () => listeners.delete(res));
          return;
        }
        if (url.pathname === "/api/extension-pair" && req.method === "POST") {
          json(res, { code: broker.createPairing() });
          return;
        }
        if (url.pathname === "/api/connect" && req.method === "POST") {
          if (agent.run)
            throw new Error(
              "Finish or cancel the current job before pairing another server",
            );
          const d = await jsonBody(req, 100000);
          const remote = serverOrigin(d.origin);
          const ca = d.ca || "";
          certificateInfo(ca);
          if (typeof d.code !== "string" || d.code.length > 100)
            throw new Error("Pairing code required");
          const response = await request(
            { origin: remote, ca },
            "/api/companion/pair",
            {
              method: "POST",
              body: {
                code: d.code,
                name: os.hostname().slice(0, 80),
                platform: `${process.platform}/${process.arch}`,
              },
            },
          );
          settings.origin = remote;
          settings.ca = ca;
          settings.token = response.data.deviceToken;
          settings.deviceId = response.data.deviceId;
          settings.pendingRun = null;
          await save();
          await agent.pulse();
          json(res, { ok: true });
          return;
        }
        if (url.pathname === "/api/download-folder" && req.method === "POST") {
          const d = await jsonBody(req);
          if (!path.isAbsolute(d.directory || ""))
            throw new Error("Use an absolute Downloads folder path");
          const stat = await fs.stat(d.directory);
          if (!stat.isDirectory()) throw new Error("Folder does not exist");
          settings.downloadRoot = await fs.realpath(d.directory);
          await save();
          json(res, { ok: true });
          return;
        }
        json(res, { error: "Unknown local endpoint" }, 404);
        return;
      }
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      };
      if (req.method !== "GET" || !files[url.pathname]) {
        res.writeHead(404);
        res.end();
        return;
      }
      const content = await fs.readFile(
        path.join(publicRoot, files[url.pathname]),
      );
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/html",
        "cache-control": "no-store",
      });
      res.end(content);
    } catch (e) {
      if (!res.headersSent) json(res, { error: e.message }, 400);
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  await agent.start();
  if (openBrowser) {
    const args =
      process.platform === "darwin"
        ? ["open", [origin]]
        : process.platform === "win32"
          ? ["cmd.exe", ["/d", "/c", "start", "", origin]]
          : ["xdg-open", [origin]];
    const child = spawn(args[0], args[1], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  }
  return {
    url: origin,
    server,
    agent,
    broker,
    settings,
    close: async () => {
      await agent.close();
      for (const l of listeners) l.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
