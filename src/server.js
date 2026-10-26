import { BrowserStartupError } from "./browserErrors.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import multer from "multer";
import argon2 from "argon2";
import { WebSocketServer } from "ws";
import { token, equal } from "./security.js";
import { readAdmin } from "./admin.js";
import { RemoteBrowser } from "./browser.js";
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
class SessionStore extends session.Store {
  constructor() {
    super();
    this.items = new Map();
  }
  get(id, done) {
    const s = this.items.get(id);
    if (s && new Date(s.cookie.expires) > new Date()) done(null, s);
    else {
      this.items.delete(id);
      done(null, null);
    }
  }
  set(id, value, done = () => {}) {
    this.items.set(id, value);
    if (this.items.size > 256)
      this.items.delete(this.items.keys().next().value);
    done();
  }
  destroy(id, done = () => {}) {
    this.items.delete(id);
    done();
  }
  touch(id, value, done = () => {}) {
    if (this.items.has(id)) this.items.set(id, value);
    done();
  }
}
export async function startServer(config, options = {}) {
  await fs.mkdir(config.data, { recursive: true, mode: 0o700 });
  const browser = new RemoteBrowser(config, options);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const sessions = new SessionStore();
  const sessionMiddleware = session({
    secret: token(),
    name: "vps-browser.sid",
    store: sessions,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.secure,
      sameSite: "strict",
      maxAge: config.sessionMs,
      path: "/",
    },
  });
  const transport = (req, res, next) => {
    if (req.headers.host !== new URL(config.origin).host)
      return res
        .status(403)
        .json({ error: "Unexpected host. Check PUBLIC_ORIGIN." });
    if (config.secure && !req.secure)
      return res.status(403).json({ error: "HTTPS is required" });
    next();
  };
  app.use(transport);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
      strictTransportSecurity: config.secure ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "20kb" }));
  app.use(sessionMiddleware);
  const admin = () => readAdmin(config.data);
  const authenticated = async (req) => {
    const a = await admin();
    return (
      a &&
      req.session?.username === a.username &&
      req.session?.version === a.version
    );
  };
  const auth = async (req, res, next) => {
    if (!(await authenticated(req)))
      return res.status(401).json({ error: "Please sign in" });
    next();
  };
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.headers.origin !== config.origin ||
        !equal(req.headers["x-csrf-token"], req.session.csrf))
    )
      return res
        .status(403)
        .json({ error: "Request expired. Refresh this page and try again." });
    next();
  });
  app.get("/api/session", async (req, res) => {
    req.session.csrf ||= token();
    const a = await admin();
    res.json({
      csrf: req.session.csrf,
      configured: !!a,
      authenticated: !!(await authenticated(req)),
      username: (await authenticated(req)) ? a.username : undefined,
    });
  });
  const attempts = new Map();
  let verifying = 0;
  app.post("/api/login", async (req, res) => {
    const now = Date.now();
    const key = req.ip;
    for (const [ip, entry] of attempts)
      if (entry.until < now) attempts.delete(ip);
    if (attempts.size > 1000)
      return res.status(429).json({ error: "Try again later" });
    const record = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
    if (record.count >= 8 || verifying >= 2)
      return res
        .status(429)
        .json({ error: "Too many attempts. Wait 15 minutes." });
    record.count++;
    attempts.set(key, record);
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      password.length > 256 ||
      username.length > 100
    )
      return res.status(400).json({ error: "Invalid credentials" });
    const a = await admin();
    verifying++;
    let valid = false;
    try {
      valid =
        !!a &&
        (await argon2.verify(a.hash, password)) &&
        username === a.username;
    } finally {
      verifying--;
    }
    if (!valid)
      return res.status(401).json({
        error: a
          ? "Incorrect username or password"
          : "Run npm run setup-admin on the VPS first",
      });
    await new Promise((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.username = a.username;
    req.session.version = a.version;
    req.session.csrf = token();
    attempts.delete(key);
    res.json({ csrf: req.session.csrf, username: a.username });
  });
  let chain = Promise.resolve();
  let pending = 0;
  let shuttingDown = false;
  const action = (d, request = null) => {
    if (shuttingDown)
      return Promise.reject(new Error("Service is shutting down"));
    if (pending >= 64)
      return Promise.reject(new Error("Input queue full. Wait a moment."));
    pending++;
    const result = chain.then(async () => {
      if (request) {
        const stored = sessions.items.get(request.sessionID);
        if (
          !stored ||
          new Date(stored.cookie.expires) <= new Date() ||
          !(await authenticated(request))
        )
          throw new Error("Session ended");
      }
      return browser.action(d);
    });
    chain = result
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return result;
  };
  app.post("/api/logout", auth, async (req, res) => {
    await new Promise((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    await action({ type: "stop" });
    res
      .clearCookie("vps-browser.sid", {
        path: "/",
        secure: config.secure,
        sameSite: "strict",
      })
      .json({ ok: true });
  });
  app.get("/api/state", auth, async (req, res) =>
    res.json(await browser.state()),
  );
  app.post("/api/action", auth, async (req, res) => {
    const d = req.body;
    if (!d || typeof d.type !== "string")
      return res.status(400).json({ error: "Invalid action" });
    try {
      await action(d, req);
      res.json(await browser.state());
    } catch (error) {
      const startup = error instanceof BrowserStartupError;
      res.status(startup ? 503 : 400).json({
        code: startup ? error.code : "ACTION_FAILED",
        error: startup
          ? error.message
          : "Action failed. Check the address or page state.",
      });
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
  });
  app.post("/api/upload", auth, upload.single("file"), async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "Choose one file (up to 20 MB)" });
    try {
      await chain;
      await browser.upload(req.file);
      res.json({ ok: true });
    } catch {
      res.status(400).json({
        error:
          "Click a file picker in the remote page first, then upload within 60 seconds.",
      });
    }
  });
  app.get("/api/downloads", auth, async (req, res) =>
    res.json((await browser.downloads()).map(({ filename, ...file }) => file)),
  );
  app.get("/api/downloads/:id", auth, async (req, res) => {
    try {
      const file = await browser.download(req.params.id);
      res.set("Content-Type", "application/octet-stream");
      res.download(file.path, file.name);
    } catch {
      res.status(404).json({ error: "Download not found" });
    }
  });
  app.delete("/api/downloads/:id", auth, async (req, res) => {
    try {
      const file = await browser.download(req.params.id);
      await fs.rm(file.path);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: "Download not found" });
    }
  });
  app.get("/api/health", auth, (req, res) =>
    res.json({ ok: true, browser: !!browser.context }),
  );
  app.use(express.static(publicDir, { index: "index.html", maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "Upload exceeds 20 MB"
          : "Request failed",
    });
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 20000,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/stream" ||
      req.headers.origin !== config.origin ||
      req.headers.host !== new URL(config.origin).host ||
      wss.clients.size >= 3 ||
      (config.secure && req.headers["x-forwarded-proto"] !== "https")
    ) {
      socket.destroy();
      return;
    }
    sessionMiddleware(req, {}, async () => {
      try {
        if (!(await authenticated(req))) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) =>
          wss.emit("connection", ws, req),
        );
      } catch {
        socket.destroy();
      }
    });
  });
  wss.on("connection", (ws, req) => {
    let busy = false;
    let inputs = 0;
    let sentState = "";
    const budget = setInterval(() => {
      inputs = 0;
    }, 1000);
    const send = (value) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(value));
    };
    const timer = setInterval(async () => {
      if (busy || ws.readyState !== 1 || ws.bufferedAmount > 750000) return;
      busy = true;
      try {
        await new Promise((resolve, reject) =>
          req.session.reload((e) => (e ? reject(e) : resolve())),
        );
        if (
          !(await authenticated(req)) ||
          new Date(req.session.cookie.expires) <= new Date()
        ) {
          ws.close(4001, "Session expired");
          return;
        }
        const state = await browser.state();
        const json = JSON.stringify(state);
        if (json !== sentState) {
          send({ type: "state", ...state });
          sentState = json;
        }
        if (browser.context && browser.pages.size) {
          const image = await browser
            .page()
            .screenshot({ type: "jpeg", quality: 65, timeout: 3000 });
          if (ws.readyState === 1) ws.send(image, { binary: true });
        }
      } catch {
        if (!sessions.items.has(req.sessionID)) ws.close(4001, "Session ended");
        // Navigation screenshots can fail transiently; retain the browser/stream.
      } finally {
        busy = false;
      }
    }, 180);
    ws.on("message", (buffer, binary) => {
      if (binary || ++inputs > 40) {
        ws.close(4008, "Input rate exceeded");
        return;
      }
      try {
        const d = JSON.parse(buffer.toString());
        if (!d || typeof d.type !== "string") throw new Error();
        action(d, req).catch((error) =>
          send({
            type: "error",
            message:
              error instanceof BrowserStartupError
                ? error.message
                : "Action could not complete. Check page state or address.",
          }),
        );
      } catch {
        send({ type: "error", message: "Invalid input" });
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(timer);
      clearInterval(budget);
    });
  });
  const idle = setInterval(() => {
    if (browser.context && Date.now() - browser.lastUsed > config.idleMs)
      action({ type: "stop" }).catch(() => {});
  }, 10000);
  idle.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return {
    server,
    app,
    browser,
    config,
    admin,
    port: server.address().port,
    async close() {
      shuttingDown = true;
      clearInterval(idle);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await chain;
      await browser.stop();
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      sessions.items.clear();
    },
  };
}
