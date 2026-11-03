import { EventEmitter } from "node:events";
import { nativeError } from "../native/common.js";
export class BrowserPipe extends EventEmitter {
  constructor(child) {
    super();
    this.input = child.stdio[3];
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    child.stdio[4].on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 2 * 1024 * 1024) return this.close();
      let end;
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const data = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const message = JSON.parse(data.toString());
          if (message.method) {
            this.emit(message.method, message.params);
            continue;
          }
          const item = this.pending.get(message.id);
          if (!item) continue;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          message.error
            ? item.reject(
                nativeError(
                  "BROWSER_PROTOCOL",
                  "Browser observation failed. Inspect the live browser and retry the check.",
                ),
              )
            : item.resolve(message.result);
        } catch {
          /* No page content or protocol errors are logged. */
        }
      }
    });
    child.once("exit", () => this.close());
    this.input.on("error", () => this.close());
    child.stdio[4].on("error", () => this.close());
  }
  send(method, params = {}, sessionId) {
    if (this.closed)
      return Promise.reject(
        nativeError("BROWSER_CLOSED", "The managed browser connection closed."),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          nativeError(
            "AUTOMATION_TIMEOUT",
            "Browser observation timed out. Inspect the page before retrying an input.",
          ),
        );
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0",
      );
    });
  }
  close() {
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        nativeError("BROWSER_CLOSED", "The managed browser connection closed."),
      );
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
}
