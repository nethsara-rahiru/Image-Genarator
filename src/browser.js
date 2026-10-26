import { navigationTarget } from "./navigation.js";
import { browserStartupError } from "./browserErrors.js";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { publicUrl } from "./security.js";
export class RemoteBrowser {
  constructor(
    config,
    { validateUrl = publicUrl, test = false, log = null } = {},
  ) {
    this.config = config;
    this.log = log;
    this.validateUrl = validateUrl;
    this.test = test;
    this.pages = new Map();
    this.activeId = null;
    this.pending = null;
    this.lastUsed = Date.now();
    this.message = "";
    this.transfers = new Set();
    this.downloadDir = path.join(config.data, "downloads");
  }
  async start() {
    if (this.context) {
      this.lastUsed = Date.now();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.launch()
      .catch((error) => {
        throw browserStartupError(error);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  async launch() {
    if (!this.test && process.getuid?.() === 0)
      throw browserStartupError(new Error("Run as a non-root Linux user"));
    await fs.mkdir(this.downloadDir, { recursive: true, mode: 0o700 });
    this.context = await chromium.launchPersistentContext(
      path.join(this.config.data, "profile"),
      {
        headless: true,
        chromiumSandbox: !this.test,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        serviceWorkers: "block",
        permissions: [],
        timeout: 30000,
        // Disable WebRTC UDP so browsing cannot probe VPS networks through ICE.
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      },
    );
    this.log?.write(
      "info",
      "browser",
      "BROWSER_STARTED",
      "Chromium started with a persistent profile.",
    );
    this.context.on("close", () => {
      this.log?.write(
        "info",
        "browser",
        "BROWSER_STOPPED",
        "Chromium closed; persistent profile retained.",
      );
      this.context = null;
      this.pages.clear();
      this.activeId = null;
      this.pending = null;
    });
    await this.context.route("**/*", async (route) => {
      try {
        await this.validateUrl(route.request().url());
        await route.continue();
      } catch (error) {
        const dns = /ENOTFOUND|EAI_AGAIN/.test(String(error?.message));
        this.log?.write(
          "warn",
          "network",
          dns ? "DNS_FAILED" : "DESTINATION_BLOCKED",
          dns
            ? "A request hostname failed DNS resolution."
            : "A browser request was blocked by public-destination validation.",
          {},
          3000,
        );
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    // WebSockets must obey the same destination boundary as HTTP requests.
    await this.context.routeWebSocket("**/*", async (socket) => {
      try {
        await this.validateUrl(
          socket.url().replace(/^ws:/, "http:").replace(/^wss:/, "https:"),
        );
        socket.connectToServer();
      } catch {
        socket.close();
      }
    });
    this.context.on("page", (page) => this.add(page));
    for (const page of this.context.pages()) this.add(page);
    if (!this.pages.size) this.add(await this.context.newPage());
    this.lastUsed = Date.now();
  }
  add(page) {
    if ([...this.pages.values()].includes(page)) return;
    if (this.pages.size >= 8) {
      page.close().catch(() => {});
      this.message = "Maximum eight tabs. Close a tab first.";
      return;
    }
    const id = randomUUID();
    page.on("pageerror", () =>
      this.log?.write(
        "warn",
        "browser",
        "PAGE_SCRIPT_ERROR",
        "Website JavaScript raised an exception; page content omitted.",
        {},
        5000,
      ),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        this.log?.write(
          "warn",
          "browser",
          "PAGE_CONSOLE_WARNING",
          "Website console emitted a warning or error; content omitted.",
          {},
          5000,
        );
    });
    page.on("crash", () =>
      this.log?.write(
        "error",
        "browser",
        "TAB_CRASHED",
        "A Chromium tab crashed. Check VPS memory and process limits.",
      ),
    );
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText || "";
      const code = failure.match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0];
      if (code && code !== "net::ERR_ABORTED")
        this.log?.write(
          "warn",
          "network",
          "REQUEST_FAILED",
          "A website request failed.",
          { networkCode: code },
          3000,
        );
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        this.log?.write(
          "warn",
          "network",
          "HTTP_ERROR",
          "A website response returned an HTTP error.",
          { status: response.status() },
          3000,
        );
    });
    this.pages.set(id, page);
    this.activeId = id;
    page.on("close", () => {
      this.pages.delete(id);
      if (this.activeId === id)
        this.activeId = this.pages.keys().next().value || null;
    });
    page.on("dialog", (dialog) => {
      this.message =
        "Website dialog dismissed. Use the page controls to continue.";
      dialog.dismiss().catch(() => {});
    });
    page.on("filechooser", (chooser) => {
      this.pending = { id, chooser, expires: Date.now() + 60000 };
      this.message = "Choose a local file using Upload in the toolbar.";
    });
    page.on("download", (download) => {
      this.log?.write(
        "info",
        "browser",
        "DOWNLOAD_STARTED",
        "A website download started.",
      );
      const transfer = this.saveDownload(download).catch(() => {
        this.log?.write(
          "error",
          "browser",
          "DOWNLOAD_FAILED",
          "Download failed, exceeded its size limit, or storage is unavailable.",
        );
        this.message =
          "Download failed, exceeded 100 MB, or storage is unavailable.";
      });
      this.transfers.add(transfer);
      transfer.finally(() => this.transfers.delete(transfer));
    });
  }
  page() {
    const page = this.pages.get(this.activeId);
    if (!page || page.isClosed()) throw new Error("Start the browser first");
    return page;
  }
  async state() {
    return {
      running: !!this.context,
      activeId: this.activeId,
      width: 1280,
      height: 800,
      message: this.message,
      uploadReady: !!this.pending && this.pending.expires > Date.now(),
      tabs: await Promise.all(
        [...this.pages].map(async ([id, p]) => ({
          id,
          url: p.url(),
          title: await p.title().catch(() => "Loading…"),
        })),
      ),
    };
  }
  async action(d) {
    this.lastUsed = Date.now();
    this.message = "";
    if (d.type === "start") {
      await this.start();
      return;
    }
    if (d.type === "stop") {
      await this.stop();
      return;
    }
    if (d.type === "newTab") {
      await this.start();
      if (this.pages.size >= 8) throw new Error("Maximum eight tabs");
      this.add(await this.context.newPage());
      return;
    }
    if (d.type === "selectTab") {
      if (!this.pages.has(d.id)) throw new Error("Tab not found");
      this.activeId = d.id;
      this.pending = null;
      return;
    }
    if (d.type === "closeTab") {
      const p = this.pages.get(d.id);
      if (!p) throw new Error("Tab not found");
      await p.close();
      this.pending = null;
      return;
    }
    const page = this.page();
    if (d.type === "navigate") {
      const url = await this.validateUrl(navigationTarget(d.url));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } else if (d.type === "back")
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 });
    else if (d.type === "forward")
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 20000 });
    else if (d.type === "reload")
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    else if (d.type === "click") {
      if (
        !Number.isFinite(d.x) ||
        !Number.isFinite(d.y) ||
        d.x < 0 ||
        d.x > 1280 ||
        d.y < 0 ||
        d.y > 800
      )
        throw new Error("Invalid coordinates");
      await page.mouse.click(d.x, d.y, {
        button: ["left", "right", "middle"].includes(d.button)
          ? d.button
          : "left",
        clickCount: d.double ? 2 : 1,
      });
    } else if (d.type === "scroll") {
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y))
        throw new Error("Invalid scroll");
      await page.mouse.wheel(
        Math.max(-2000, Math.min(2000, d.x)),
        Math.max(-2000, Math.min(2000, d.y)),
      );
    } else if (d.type === "text") {
      if (typeof d.text !== "string" || d.text.length > 10000)
        throw new Error("Text is too long");
      await page.keyboard.insertText(d.text);
    } else if (d.type === "key") {
      if (typeof d.key !== "string" || !validKey(d.key))
        throw new Error("Unsupported key");
      await page.keyboard.press(d.key);
    } else throw new Error("Unknown action");
  }
  async upload(file) {
    if (
      !this.pending ||
      this.pending.expires < Date.now() ||
      this.pending.id !== this.activeId
    )
      throw new Error("Click a file upload control in the remote page first");
    const pending = this.pending;
    this.pending = null;
    await pending.chooser.setFiles(
      {
        name: path.basename(file.originalname).replace(/[\x00-\x1f]/g, "_"),
        mimeType: file.mimetype,
        buffer: file.buffer,
      },
      { timeout: 15000 },
    );
    this.lastUsed = Date.now();
    this.log?.write(
      "info",
      "browser",
      "UPLOAD_COMPLETED",
      "File transferred into the selected website file picker.",
    );
  }
  async saveDownload(download) {
    const name =
      path
        .basename(download.suggestedFilename())
        .replace(/[^a-zA-Z0-9._ -]/g, "_")
        .slice(0, 100) || "download";
    const id = randomUUID();
    const target = path.join(this.downloadDir, `${id}--${name}`);
    const temp = `${target}.partial`;
    let bytes = 0;
    try {
      const stream = await download.createReadStream();
      if (!stream) throw new Error("No download stream");
      await pipeline(
        stream,
        new Transform({
          transform(chunk, encoding, done) {
            bytes += chunk.length;
            done(
              bytes > 100 * 1024 * 1024 ? new Error("Download limit") : null,
              chunk,
            );
          },
        }),
        createWriteStream(temp, { mode: 0o600, flags: "wx" }),
      );
      if (await download.failure()) throw new Error("Interrupted download");
      await fs.rename(temp, target);
      this.message = `Downloaded ${name}`;
      this.log?.write(
        "info",
        "browser",
        "DOWNLOAD_COMPLETED",
        "Original file saved; available in Downloads.",
      );
    } catch (e) {
      await download.cancel().catch(() => {});
      await fs.rm(temp, { force: true });
      throw e;
    } finally {
      await download.delete().catch(() => {});
    }
    await this.prune();
  }
  async downloads() {
    await fs.mkdir(this.downloadDir, { recursive: true, mode: 0o700 });
    const files = await fs.readdir(this.downloadDir);
    const result = [];
    for (const filename of files) {
      if (!/^[a-f0-9-]{36}--/.test(filename) || filename.endsWith(".partial"))
        continue;
      const stat = await fs.lstat(path.join(this.downloadDir, filename));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      result.push({
        id: filename.slice(0, 36),
        name: filename.slice(38),
        bytes: stat.size,
        created: stat.mtime.toISOString(),
        filename,
      });
    }
    return result.sort((a, b) => b.created.localeCompare(a.created));
  }
  async prune() {
    for (const file of (await this.downloads()).slice(100))
      await fs.rm(path.join(this.downloadDir, file.filename), { force: true });
  }
  async download(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid download");
    const file = (await this.downloads()).find((f) => f.id === id);
    if (!file) throw new Error("Download not found");
    return { ...file, path: path.join(this.downloadDir, file.filename) };
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    const context = this.context;
    if (context) await context.close();
    this.context = null;
    this.pending = null;
    this.pages.clear();
    this.activeId = null;
    await Promise.allSettled([...this.transfers]);
  }
}
function validKey(key) {
  const parts = key.split("+");
  const last = parts.pop();
  return (
    parts.every((p) => ["Control", "Meta", "Alt", "Shift"].includes(p)) &&
    (/^[a-zA-Z0-9]$/.test(last) ||
      [
        "Enter",
        "Tab",
        "Backspace",
        "Delete",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space",
        "F5",
      ].includes(last))
  );
}
