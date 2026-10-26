import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export class DebugLog {
  constructor(
    data,
    { maxEntries = 500, maxBytes = 1024 * 1024, stdout = true } = {},
  ) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.stdout = stdout;
    this.dir = path.join(data, "logs");
    this.file = path.join(this.dir, "debug.jsonl");
    this.entries = [];
    this.generation = randomUUID();
    this.boot = randomUUID();
    this.sequence = 0;
    this.last = new Map();
    this.storageError = false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const filename of [`${this.file}.1`, this.file]) {
      try {
        const stat = fs.lstatSync(filename);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > this.maxBytes * 2
        )
          continue;
        for (const line of fs.readFileSync(filename, "utf8").split("\n")) {
          try {
            const entry = JSON.parse(line);
            if (this.valid(entry)) this.entries.push(entry);
          } catch {}
        }
      } catch {}
    }
    this.entries = this.entries.slice(-this.maxEntries);
  }
  valid(e) {
    return (
      e &&
      ["info", "warn", "error"].includes(e.level) &&
      /^[A-Z0-9_]{1,60}$/.test(e.code) &&
      typeof e.id === "string" &&
      typeof e.timestamp === "string" &&
      typeof e.message === "string" &&
      e.message.length <= 500 &&
      ["server", "browser", "network", "viewer", "auth"].includes(e.source)
    );
  }
  write(level, source, code, message, details = {}, dedupeMs = 0) {
    const now = Date.now();
    const key = `${source}:${code}`;
    if (dedupeMs && now - (this.last.get(key) || 0) < dedupeMs) return;
    this.last.set(key, now);
    if (this.last.size > 100) this.last.delete(this.last.keys().next().value);
    const safe = {};
    // Never persist typed text, key values, URLs, query strings, credentials or page console text.
    if (
      typeof details.action === "string" &&
      /^[a-zA-Z]{1,24}$/.test(details.action)
    )
      safe.action = details.action;
    if (
      typeof details.actionId === "string" &&
      /^[a-f0-9-]{36}$/.test(details.actionId)
    )
      safe.actionId = details.actionId;
    if (Number.isFinite(details.durationMs))
      safe.durationMs = Math.max(0, Math.round(details.durationMs));
    if (
      Number.isInteger(details.status) &&
      details.status >= 100 &&
      details.status <= 599
    )
      safe.status = details.status;
    if (
      typeof details.networkCode === "string" &&
      /^(net::)?ERR_[A-Z0-9_]{1,80}$/.test(details.networkCode)
    )
      safe.networkCode = details.networkCode;
    const entry = {
      id: `${this.boot}:${++this.sequence}`,
      timestamp: new Date(now).toISOString(),
      level,
      source,
      code,
      message: message.slice(0, 500),
      details: safe,
    };
    if (!this.valid(entry)) throw new Error("Invalid internal log entry");
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    const line = JSON.stringify(entry) + "\n";
    try {
      if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())
        throw new Error("Unsafe log path");
      if (
        fs.existsSync(this.file) &&
        fs.statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes
      ) {
        fs.rmSync(`${this.file}.1`, { force: true });
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.storageError = false;
    } catch {
      this.storageError = true;
    }
    if (this.stdout) console.log(line.trimEnd());
    return entry;
  }
  snapshot(after) {
    const index = after ? this.entries.findIndex((e) => e.id === after) : -1;
    return {
      generation: this.generation,
      entries: index < 0 ? this.entries : this.entries.slice(index + 1),
      cursor: this.entries.at(-1)?.id || null,
      storageError: this.storageError,
    };
  }
  clear() {
    this.generation = randomUUID();
    this.entries = [];
    for (const file of [this.file, `${this.file}.1`])
      fs.rmSync(file, { force: true });
    this.write(
      "info",
      "server",
      "LOG_CLEARED",
      "Debug history cleared by administrator.",
    );
  }
}
