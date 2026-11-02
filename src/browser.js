import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { navigationTarget } from "./navigation.js";
import { publicUrl } from "./security.js";
import { LinuxDriver } from "./native/linux.js";
import { DesktopDriver } from "./native/desktop.js";
import {
  chromeExecutable,
  browserArguments,
  nativeError,
  terminate,
  validKey,
  launchFailure,
} from "./native/common.js";
import { startBrowserProxy } from "./native/proxy.js";
export class RemoteBrowser {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.log = options.log;
    this.platform = options.platform || process.platform;
    this.data = path.join(config.data, "native");
    this.profile = path.join(config.data, "native-profile");
    this.downloadDir = path.join(config.data, "downloads");
    this.uploadDir = path.join(config.data, "uploads");
    this.width = 1280;
    this.height = 900;
    this.hasFrame = false;
    this.lastUsed = Date.now();
    this.message = "";
    this.child = null;
  }
  get running() {
    return (
      !!this.child && this.child.exitCode === null && !this.child.signalCode
    );
  }
  async start() {
    if (this.running) return;
    if (this.cleaning) await this.cleaning;
    if (this.starting) return this.starting;
    this.starting = this.launch()
      .catch(async (error) => {
        await terminate(this.child);
        this.child = null;
        await this.cleanup();
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  async launch() {
    if (!this.options.test && process.getuid?.() === 0)
      throw nativeError(
        "BROWSER_ROOT",
        "Run this app as a normal desktop user, not root.",
      );
    const binary = await chromeExecutable(
      this.platform,
      this.options.chromePath || this.config.chromePath,
    );
    for (const dir of [
      this.data,
      this.profile,
      this.downloadDir,
      this.uploadDir,
    ])
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      this.release = await lockfile.lock(this.profile, {
        stale: 15000,
        update: 3000,
        retries: 0,
        onCompromised: () => this.stop().catch(() => {}),
      });
    } catch {
      throw nativeError(
        "BROWSER_PROFILE_BUSY",
        "Another app instance owns this Chrome profile. Stop that instance before retrying.",
      );
    }
    const record = path.join(this.data, "browser.json");
    try {
      const old = JSON.parse(await fs.readFile(record, "utf8"));
      if (Number.isInteger(old.pid)) {
        let live = false;
        try {
          process.kill(old.pid, 0);
          live = true;
        } catch {}
        if (live)
          throw nativeError(
            "BROWSER_PROFILE_BUSY",
            "A previous managed Chrome process is still running. Close it on this PC before retrying.",
          );
      }
    } catch (error) {
      if (error.code === "BROWSER_PROFILE_BUSY") throw error;
    }
    const preferencesFile = path.join(this.profile, "Default", "Preferences");
    await fs.mkdir(path.dirname(preferencesFile), {
      recursive: true,
      mode: 0o700,
    });
    let preferences = {};
    try {
      preferences = JSON.parse(await fs.readFile(preferencesFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw nativeError(
          "PROFILE_PREFERENCES_INVALID",
          "The managed Chrome preferences could not be read. Back up the native profile and run npm run doctor.",
        );
    }
    preferences.download = {
      ...preferences.download,
      default_directory: this.downloadDir,
      prompt_for_download: false,
      directory_upgrade: true,
    };
    const temporary = preferencesFile + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
    await fs.rename(temporary, preferencesFile);
    this.proxy = await startBrowserProxy({
      log: this.log,
      ...this.options.proxyOptions,
    });
    this.driver =
      this.options.driver ||
      (this.platform === "linux"
        ? new LinuxDriver(this.data)
        : new DesktopDriver(this.platform, this.data));
    const env = await this.driver.prepare();
    const args = browserArguments(this.profile, this.proxy.port, {
      test: this.options.test,
      platform: this.platform,
      homepage: this.options.homepage || "https://www.google.com/",
    });
    this.child = spawn(binary, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: false,
    });
    let startupOutput = "";
    this.child.stderr.on("data", (chunk) => {
      if (this.starting)
        startupOutput = (startupOutput + chunk.toString()).slice(-10000);
    });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", () =>
        reject(
          nativeError(
            "CHROME_START_FAILED",
            "Desktop Chrome could not be launched. Check CHROME_PATH and npm run doctor.",
          ),
        ),
      );
    });
    this.driver.setProcess?.(this.child.pid);
    await fs.writeFile(record, JSON.stringify({ pid: this.child.pid }), {
      mode: 0o600,
    });
    this.child.once("exit", () => {
      this.hasFrame = false;
      this.log?.write(
        "info",
        "browser",
        "BROWSER_STOPPED",
        "Managed desktop Chrome exited.",
      );
      this.cleanup().catch(() => {});
    });
    await pause(500);
    if (!this.running) throw launchFailure(startupOutput);
    this.lastUsed = Date.now();
    this.log?.write(
      "info",
      "browser",
      "BROWSER_STARTED",
      "Desktop Chrome started. Viewer uses native capture and OS input, without a browser debugging connection.",
    );
  }
  async capture() {
    if (!this.running)
      throw nativeError("BROWSER_CLOSED", "Start the browser first.");
    const frame = await this.driver.capture();
    if (
      frame.width > 4096 ||
      frame.height > 2304 ||
      frame.width < 100 ||
      frame.height < 100
    )
      throw nativeError(
        "FRAME_TOO_LARGE",
        "Resize the managed browser to at most 4096 × 2304 pixels.",
      );
    this.width = frame.width;
    this.height = frame.height;
    this.hasFrame = true;
    return frame.image;
  }
  async state() {
    return {
      running: this.running,
      platform: this.platform,
      mode: "native",
      width: this.width,
      height: this.height,
      frameReady: this.hasFrame,
      message: this.message,
      uploadReady: this.running,
    };
  }
  async action(d) {
    this.lastUsed = Date.now();
    this.message = "";
    if (d.type === "start") return this.start();
    if (d.type === "stop") return this.stop();
    if (!this.running)
      throw nativeError("BROWSER_CLOSED", "Start the browser first.");
    const command = this.platform === "darwin" ? "Meta" : "Control";
    const key = (value) => this.driver.command({ type: "key", key: value });
    if (d.type === "navigate") {
      const url = await (this.options.validateUrl || publicUrl)(
        navigationTarget(d.url),
      );
      await key(`${command}+L`);
      await this.driver.command({ type: "text", text: url });
      await key("Enter");
    } else if (d.type === "devtools")
      await key(this.platform === "darwin" ? "Meta+Alt+j" : "Control+Shift+j");
    else if (d.type === "newTab") await key(`${command}+t`);
    else if (d.type === "closeTab") await key(`${command}+w`);
    else if (d.type === "back")
      await key(
        this.platform === "darwin" ? "Meta+ArrowLeft" : "Alt+ArrowLeft",
      );
    else if (d.type === "forward")
      await key(
        this.platform === "darwin" ? "Meta+ArrowRight" : "Alt+ArrowRight",
      );
    else if (d.type === "reload") await key(`${command}+r`);
    else if (d.type === "click") {
      if (
        !Number.isFinite(d.x) ||
        !Number.isFinite(d.y) ||
        d.x < 0 ||
        d.y < 0 ||
        d.x >= this.width ||
        d.y >= this.height
      )
        throw new Error("Invalid coordinates");
      await this.driver.command({
        type: "click",
        x: d.x,
        y: d.y,
        button: ["left", "right", "middle"].includes(d.button)
          ? d.button
          : "left",
        double: !!d.double,
      });
    } else if (d.type === "scroll") {
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y))
        throw new Error("Invalid scroll");
      await this.driver.command({
        type: "scroll",
        x: Math.max(-2000, Math.min(2000, d.x)),
        y: Math.max(-2000, Math.min(2000, d.y)),
      });
    } else if (d.type === "text") {
      if (typeof d.text !== "string" || d.text.length > 10000)
        throw new Error("Text is too long");
      await this.driver.command({ type: "text", text: d.text });
    } else if (d.type === "key") {
      if (!validKey(d.key)) throw new Error("Unsupported key");
      await key(d.key);
    } else throw new Error("Unknown action");
  }
  async upload(file) {
    if (!this.running)
      throw nativeError("BROWSER_CLOSED", "Start the browser first.");
    const filename =
      randomUUID() +
      "-" +
      path
        .basename(file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
    const target = path.join(this.uploadDir, filename);
    await fs.writeFile(target, file.buffer, { mode: 0o600, flag: "wx" });
    try {
      await this.driver.upload(target);
      this.log?.write(
        "info",
        "browser",
        "UPLOAD_COMPLETED",
        "File supplied to the native website file chooser.",
      );
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
    const items = await fs.readdir(this.uploadDir);
    if (items.length > 20)
      for (const name of items.slice(0, items.length - 20))
        await fs.rm(path.join(this.uploadDir, name), { force: true });
  }
  async downloads() {
    await fs.mkdir(this.downloadDir, { recursive: true, mode: 0o700 });
    const base = await fs.realpath(this.downloadDir);
    const list = [];
    for (const filename of await fs.readdir(base)) {
      if (
        filename.startsWith(".") ||
        /\.(crdownload|part|tmp|download)$/i.test(filename)
      )
        continue;
      const target = path.join(base, filename);
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch {
        continue;
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 100 * 1024 * 1024
      )
        continue;
      list.push({
        id: createHash("sha256").update(filename).digest("hex"),
        name: filename,
        filename,
        bytes: stat.size,
        created: stat.mtime.toISOString(),
      });
    }
    list.sort((a, b) => b.created.localeCompare(a.created));
    for (const file of list.slice(100))
      await fs.rm(path.join(base, file.filename), { force: true });
    return list.slice(0, 100);
  }
  async download(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid download");
    const file = (await this.downloads()).find((e) => e.id === id);
    if (!file) throw new Error("Download not found");
    return {
      ...file,
      path: path.join(await fs.realpath(this.downloadDir), file.filename),
    };
  }
  async cleanup() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = (async () => {
      await this.driver?.close().catch(() => {});
      this.driver = null;
      await this.proxy?.close().catch(() => {});
      this.proxy = null;
      await this.release?.().catch(() => {});
      this.release = null;
    })().finally(() => {
      this.cleaning = null;
    });
    return this.cleaning;
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    await this.driver?.command({ type: "close" }).catch(() => {});
    if (child && child.exitCode === null && !child.signalCode)
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        pause(1500),
      ]);
    await terminate(child);
    this.child = null;
    this.hasFrame = false;
    await this.cleanup();
    if (child?.pid) {
      const record = path.join(this.data, "browser.json");
      try {
        const saved = JSON.parse(await fs.readFile(record, "utf8"));
        if (saved.pid === child.pid) await fs.rm(record, { force: true });
      } catch {}
    }
  }
}
