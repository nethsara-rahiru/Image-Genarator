import { macHelperError } from "./macosErrors.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, nativeError, terminate, jpegDimensions } from "./common.js";
const windowsScript = fileURLToPath(new URL("./windows.ps1", import.meta.url));
const macScript = fileURLToPath(new URL("./macos.js", import.meta.url));
export class DesktopDriver {
  constructor(platform, data) {
    this.platform = platform;
    this.data = data;
    this.pending = [];
    this.queue = Promise.resolve();
    this.frameWidth = 1280;
    this.frameHeight = 900;
  }
  async prepare() {
    if (this.platform === "win32") {
      const command = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      this.helper = spawn(
        command,
        ["-NoProfile", "-NonInteractive", "-File", windowsScript],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      this.helper.stderr.on("data", () => {});
      this.helper.stdin.on("error", () => {});
      const fail = () => {
        for (const p of this.pending.splice(0))
          p.reject(
            nativeError(
              "DESKTOP_PERMISSION_REQUIRED",
              "Windows capture/control is unavailable. Check PowerShell policy, desktop access and npm run doctor.",
            ),
          );
      };
      this.helper.on("error", fail);
      this.helper.on("exit", fail);
      const lines = createInterface({ input: this.helper.stdout });
      lines.on("line", (line) => {
        const next = this.pending.shift();
        if (!next) return;
        try {
          const parsed = JSON.parse(line);
          parsed.ok
            ? next.resolve(parsed.result)
            : next.reject(
                nativeError(
                  parsed.code === "FILE_DIALOG_REQUIRED"
                    ? "FILE_DIALOG_REQUIRED"
                    : "DESKTOP_PERMISSION_REQUIRED",
                  parsed.code === "FILE_DIALOG_REQUIRED"
                    ? "Click a website file picker before uploading."
                    : "The managed Chrome window could not be captured or controlled. Unlock the PC, allow desktop access, and retry.",
                ),
              );
        } catch {
          next.reject(
            nativeError(
              "NATIVE_PROTOCOL_FAILED",
              "The native helper returned an invalid response.",
            ),
          );
        }
      });
    }
    return process.env;
  }
  setProcess(pid) {
    this.pid = pid;
  }
  async call(request) {
    const result = this.queue.then(() =>
      this.perform({
        ...request,
        pid: this.pid,
        frameWidth: this.frameWidth,
        frameHeight: this.frameHeight,
      }),
    );
    this.queue = result.catch(() => {});
    return result;
  }
  async perform(request) {
    if (this.platform === "darwin") {
      const bytes = await run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", macScript],
        { input: JSON.stringify(request), timeout: 12000 },
      );
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString());
      } catch {
        throw nativeError(
          "NATIVE_PROTOCOL_FAILED",
          "The macOS helper returned an invalid response.",
        );
      }
      if (!parsed.ok) throw macHelperError(parsed);
      return parsed.result;
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        this.helper?.kill();
        reject(
          nativeError(
            "NATIVE_TIMEOUT",
            "The Windows native helper timed out. Check desktop access and PowerShell policy.",
          ),
        );
      }, 15000);
      this.pending.push(entry);
      this.helper.stdin.write(JSON.stringify(request) + "\n", (error) => {
        if (error) {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          entry.reject(
            nativeError(
              "NATIVE_HELPER_MISSING",
              "The Windows native helper is not running. Restart the browser.",
            ),
          );
        }
      });
    });
  }
  async capture() {
    const result = await this.call({ type: "capture" });
    let image;
    if (this.platform === "darwin") {
      const temp = path.join(this.data, "frame.jpg");
      try {
        await run(
          "/usr/sbin/screencapture",
          ["-x", "-o", "-l", String(result.windowId), "-t", "jpg", temp],
          { timeout: 5000 },
        );
        image = await fs.readFile(temp);
      } catch (error) {
        throw macHelperError({
          code:
            result.permissions?.screenRecording === false
              ? "MAC_SCREEN_RECORDING_REQUIRED"
              : "MAC_CAPTURE_FAILED",
        });
      } finally {
        await fs.rm(temp, { force: true });
      }
    } else image = Buffer.from(result.image, "base64");
    const dimensions = jpegDimensions(image);
    this.frameWidth = dimensions.width;
    this.frameHeight = dimensions.height;
    return { image, ...dimensions };
  }
  async diagnostics() {
    return this.call({ type: "diagnostics" });
  }
  async command(request) {
    await this.call(request);
  }
  async upload(file) {
    await this.call({ type: "upload", file });
  }
  async close() {
    if (this.pid) await this.call({ type: "close" }).catch(() => {});
    await terminate(this.helper);
    this.helper = null;
    this.pid = null;
  }
}
