import { setTimeout as pause } from "node:timers/promises";
import { nativeError } from "../native/common.js";
import { pageOperation } from "./page.js";
export const GEMINI_URL = "https://gemini.google.com/app";
export const GOOGLE_LOGIN =
  "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
export class GeminiAdapter {
  constructor(browser) {
    this.browser = browser;
  }
  async evaluate(request) {
    if (!this.browser.pipe || !this.session)
      throw nativeError(
        "AUTOMATION_NOT_READY",
        "Start the Gemini automation first.",
      );
    const result = await this.browser.pipe.send(
      "Runtime.evaluate",
      {
        expression: `(${pageOperation.toString()})(${JSON.stringify({ ...request, ...(this.browser.options.test && this.browser.options.automationOrigins ? { origins: this.browser.options.automationOrigins } : {}) })})`,
        returnByValue: true,
      },
      this.session,
    );
    if (result.exceptionDetails || !result.result?.value)
      throw nativeError(
        "PAGE_CHANGED",
        "The page changed during observation. Inspect the browser before retrying.",
      );
    return result.result.value;
  }
  async open(which) {
    const original = which === "gemini" ? GEMINI_URL : GOOGLE_LOGIN;
    const url = await (
      this.browser.options.validateUrl ||
      (await import("../security.js")).publicUrl
    )(original);
    if (this.target && this.session) {
      try {
        await this.browser.pipe.send("Page.navigate", { url }, this.session);
        await this.browser.pipe.send("Page.bringToFront", {}, this.session);
        return;
      } catch {
        this.target = null;
        this.session = null;
      }
    }
    if (!this.target) {
      const { targetId } = await this.browser.pipe.send("Target.createTarget", {
        url,
      });
      this.target = targetId;
      const { sessionId } = await this.browser.pipe.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      this.session = sessionId;
    }
    await this.browser.pipe.send("Page.bringToFront", {}, this.session);
  }
  async observe({ previous, timeout = 8000, signal } = {}) {
    const until = Date.now() + timeout;
    let latest = { kind: "unknown", site: "blocked", candidates: [] };
    do {
      if (signal?.aborted)
        throw nativeError(
          "AUTOMATION_CANCELLED",
          "Automation was interrupted.",
        );
      try {
        latest = await this.evaluate({ operation: "observe" });
      } catch (error) {
        if (!this.browser.running) throw error;
      }
      if (
        latest.kind !== "loading" &&
        latest.kind !== "unknown" &&
        (!previous || latest.kind !== previous.kind || latest.error)
      )
        return latest;
      await pause(200);
    } while (Date.now() < until);
    return latest;
  }
  async click(candidate, kind) {
    const result = await this.evaluate({
      operation: "click",
      id: candidate.id,
      action: candidate.action,
      kind,
    });
    if (!result.ok)
      throw nativeError(
        "PAGE_CHANGED",
        "The requested browser button is no longer valid. Inspect the page before retrying.",
      );
  }
  async fill(kind, value) {
    if (typeof value !== "string" || !value.length || value.length > 1000)
      throw nativeError("INVALID_INPUT", "Enter a value of 1–1000 characters.");
    const result = await this.evaluate({ operation: "fill", kind, value });
    if (!result.ok)
      throw nativeError(
        "PAGE_CHANGED",
        "The expected Google sign-in field is not available. No input was entered.",
      );
    const view = await this.evaluate({ operation: "observe" });
    const next = view.candidates.filter((c) => c.action === "next");
    if (view.kind !== kind || next.length !== 1)
      throw nativeError(
        "INPUT_NEEDS_REVIEW",
        "Input was entered, but the Next button could not be verified. Inspect the browser; no automatic retry will occur.",
      );
    await this.click(next[0], kind);
    const after = await this.observe({ previous: view });
    if (after.kind === kind && !after.error)
      throw nativeError(
        "INPUT_NEEDS_REVIEW",
        "Next was submitted once, but its result is ambiguous. Inspect the browser before retrying input.",
      );
    return after;
  }
}
