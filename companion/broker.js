import crypto from "node:crypto";
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
export class BrowserBroker {
  constructor(settings, save) {
    this.settings = settings;
    this.save = save;
    this.connections = new Map();
    this.pending = new Map();
    this.pairings = new Map();
  }
  createPairing() {
    const code = crypto.randomBytes(18).toString("base64url");
    this.pairings.set(hash(code), Date.now() + 300000);
    return code;
  }
  async register(d, origin) {
    if (
      !/^[a-zA-Z0-9_-]{24}$/.test(d.code || "") ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(origin || "") ||
      !/^[a-f\d-]{36}$/i.test(d.id || "") ||
      typeof d.label !== "string" ||
      d.label.length > 80
    )
      throw new Error("Invalid extension pairing");
    const key = hash(d.code);
    if ((this.pairings.get(key) || 0) < Date.now())
      throw new Error("Extension pairing code expired or invalid");
    this.pairings.delete(key);
    const token = crypto.randomBytes(32).toString("base64url");
    const previous = this.settings.browsers.find((b) => b.id === d.id);
    if (previous && this.pending.has(d.id))
      throw new Error("Browser has an active job");
    this.settings.browsers = this.settings.browsers.filter(
      (b) => b.id !== d.id,
    );
    this.settings.browsers.push({
      id: d.id,
      label: d.label.trim() || "Browser profile",
      origin,
      tokenHash: hash(token),
    });
    await this.save();
    return { token, id: d.id };
  }
  authorize(req, origin = req.headers.origin) {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const b = this.settings.browsers.find(
      (b) => b.origin === origin && b.tokenHash === hash(token),
    );
    if (!b) throw new Error("Extension authorization failed");
    return b;
  }
  attach(browser, res) {
    const old = this.connections.get(browser.id);
    old?.res.end();
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "access-control-allow-origin": browser.origin,
      "x-content-type-options": "nosniff",
    });
    const connection = { res, lastSeen: Date.now() };
    this.connections.set(browser.id, connection);
    const send = () => {
      if (res.destroyed) return;
      if (res.writableLength > 100000) {
        res.destroy();
        return;
      }
      res.write(
        JSON.stringify({
          type: "tick",
          currentTask: this.pending.get(browser.id)?.id || null,
        }) + "\n",
      );
    };
    send();
    const timer = setInterval(send, 3000);
    res.on("close", () => {
      clearInterval(timer);
      if (this.connections.get(browser.id) === connection)
        this.connections.delete(browser.id);
    });
  }
  heartbeat(id) {
    const c = this.connections.get(id);
    if (c) c.lastSeen = Date.now();
  }
  online() {
    return this.settings.browsers
      .filter((b) => {
        const c = this.connections.get(b.id);
        return c && !c.res.destroyed && c.lastSeen > Date.now() - 12000;
      })
      .map((b) => ({ id: b.id, label: b.label }));
  }
  available() {
    return this.online()
      .filter((b) => !this.pending.has(b.id))
      .map((b) => b.id);
  }
  run(browserId, task, timeout = 900000) {
    if (!this.online().some((b) => b.id === browserId))
      throw new Error(
        "Open the companion extension tab in this browser profile",
      );
    if (this.pending.has(browserId))
      throw new Error("Browser already has an active task");
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.cancel(browserId, "LOCAL_DISCONNECTED");
      }, timeout);
      this.pending.set(browserId, { id, task, resolve, reject, timer });
      this.connections
        .get(browserId)
        .res.write(JSON.stringify({ type: "task", id, task }) + "\n");
    });
  }
  task(browserId, taskId) {
    const task = this.pending.get(browserId);
    if (!task || task.id !== taskId)
      throw new Error("Task is no longer active");
    return task;
  }
  result(browserId, d) {
    const p = this.task(browserId, d.id);
    clearTimeout(p.timer);
    this.pending.delete(browserId);
    if (d.error) {
      const e = new Error(d.error.message || "Browser action failed");
      e.code = d.error.code || "AUTOMATION";
      p.reject(e);
    } else p.resolve(d.result);
  }
  cancel(browserId, code = "CANCELLED") {
    const p = this.pending.get(browserId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(browserId);
    const c = this.connections.get(browserId);
    if (c && !c.res.destroyed)
      c.res.write(JSON.stringify({ type: "abort", id: p.id, code }) + "\n");
    const e = new Error(code);
    e.code = code;
    p.reject(e);
  }
  close() {
    for (const id of this.pending.keys()) this.cancel(id, "LOCAL_DISCONNECTED");
    for (const c of this.connections.values()) c.res.end();
  }
}
