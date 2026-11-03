import { randomUUID } from "node:crypto";
import { actionError } from "./actionErrors.js";
export const GEMINI_URL = "https://gemini.google.com/app";
export const GOOGLE_LOGIN =
  "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const active = new Set([
  "cancelling",
  "starting",
  "opening_google",
  "awaiting_signin",
  "opening_gemini",
  "awaiting_confirmation",
]);
export class GeminiFlow {
  constructor(action, log) {
    this.action = action;
    this.log = log;
    this.value = { state: "idle", steps: [] };
  }
  snapshot() {
    return structuredClone(this.value);
  }
  update(state, message) {
    this.value.state = state;
    this.value.message = message;
    this.value.updatedAt = new Date().toISOString();
    this.value.steps.push({ state, message, at: this.value.updatedAt });
    this.log?.write("info", "browser", "GEMINI_FLOW_STEP", message);
  }
  async execute(fn) {
    const id = this.value.id;
    try {
      await fn();
    } catch (error) {
      const diagnosed = actionError(error);
      if (this.value.id !== id || this.value.state === "cancelling") return;
      this.update("failed", diagnosed.message);
      this.value.code = diagnosed.code;
    }
  }
  start() {
    if (active.has(this.value.state))
      throw new Error("A Gemini sign-in flow is already active");
    this.value = { id: randomUUID(), state: "starting", steps: [] };
    this.update(
      "starting",
      "Starting the dedicated browser and restoring its saved profile.",
    );
    const id = this.value.id;
    this.task = this.execute(async () => {
      await this.action({ type: "start" });
      if (this.value.id !== id || this.value.state !== "starting") return;
      this.update(
        "opening_google",
        "Opening Google's account chooser for Gemini.",
      );
      await this.action({ type: "navigate", url: GOOGLE_LOGIN });
      if (this.value.id !== id || this.value.state !== "opening_google") return;
      this.update(
        "awaiting_signin",
        "Your input is required: sign in on Google's page in the live browser below. Complete any MFA or security checks there, then choose Open Gemini.",
      );
    });
    return this.snapshot();
  }
  proceed(id) {
    this.check(id, "awaiting_signin");
    this.update(
      "opening_gemini",
      "Opening Gemini with the current browser profile.",
    );
    this.task = this.execute(async () => {
      await this.action({ type: "navigate", url: GEMINI_URL });
      if (this.value.id !== id || this.value.state !== "opening_gemini") return;
      this.update(
        "awaiting_confirmation",
        "Check the live browser. Confirm only if Gemini is signed in and ready. If Google rejects the session, use Cancel; the app cannot bypass that restriction.",
      );
    });
    return this.snapshot();
  }
  confirm(id) {
    this.check(id, "awaiting_confirmation");
    this.update(
      "user_confirmed",
      "You confirmed that Gemini is ready. Authentication has not been independently verified by the app; the browser profile remains saved.",
    );
    return this.snapshot();
  }
  check(id, state) {
    if (id !== this.value.id || this.value.state !== state)
      throw new Error("Flow changed. Refresh its status before continuing.");
  }
  async cancel(id) {
    if (
      id !== this.value.id ||
      !active.has(this.value.state) ||
      this.value.state === "cancelling"
    )
      throw new Error("No matching active flow");
    this.update(
      "cancelling",
      "Waiting for the current browser operation, then stopping the browser.",
    );
    // Await the bounded startup/navigation operation before closing its owned browser.
    await this.task;
    try {
      await this.action({ type: "stop" });
      this.update(
        "cancelled",
        "Browser stopped. Saved sessions were retained.",
      );
    } catch (error) {
      const diagnosed = actionError(error);
      this.update("failed", diagnosed.message);
      this.value.code = diagnosed.code;
    }
    return this.snapshot();
  }
  interrupted() {
    if (active.has(this.value.state) && this.value.state !== "cancelling")
      this.update(
        "interrupted",
        "Browser stopped. Start a new flow to resume with the saved profile.",
      );
  }
}
