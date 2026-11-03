import { randomUUID } from "node:crypto";
import { actionError } from "./actionErrors.js";
export { GEMINI_URL, GOOGLE_LOGIN } from "./automation/adapter.js";
const terminal = new Set([
  "idle",
  "already_signed_in",
  "signed_in",
  "cancelled",
  "interrupted",
  "failed",
]);
export class GeminiFlow {
  constructor(action, log, recovery) {
    this.action = action;
    this.log = log;
    this.recovery = recovery;
    this.value = { state: "idle", steps: [] };
  }
  snapshot() {
    return structuredClone({
      ...this.value,
      active: !terminal.has(this.value.state),
    });
  }
  update(state, message) {
    this.value.state = state;
    this.value.message = message;
    this.value.updatedAt = new Date().toISOString();
    this.value.steps.push({ state, message, at: this.value.updatedAt });
    this.value.steps = this.value.steps.slice(-50);
    this.log?.write("info", "browser", "GEMINI_FLOW_STEP", message);
  }
  current(id) {
    return (
      this.value.id === id &&
      !this.controller.signal.aborted &&
      !terminal.has(this.value.state)
    );
  }
  run(fn) {
    const id = this.value.id;
    this.task = (async () => {
      try {
        await fn(id);
      } catch (error) {
        if (this.current(id)) {
          const e = actionError(error);
          delete this.value.input;
          this.update(
            "needs_review",
            e.message +
              " No input will be automatically retried; inspect the live browser.",
          );
          this.value.code = e.code;
        }
      }
    })();
  }
  async command(command, rest = {}) {
    return this.action({
      type: "automation",
      command,
      ...rest,
      ...(command === "observe"
        ? { options: { ...rest.options, signal: this.controller.signal } }
        : {}),
    });
  }
  start() {
    if (!terminal.has(this.value.state)) throw new Error("Flow active");
    this.controller = new AbortController();
    this.attempts = 0;
    this.loginOpened = false;
    this.usedChooser = false;
    this.value = { id: randomUUID(), state: "starting", steps: [] };
    this.update(
      "starting",
      "Starting browser observation with the saved isolated profile. An existing manual browser may restart to enable the private automation pipe.",
    );
    this.run(async (id) => {
      await this.action({ type: "start", automation: true });
      if (!this.current(id)) return;
      this.update(
        "checking_gemini",
        "Opening Gemini first and checking visible account and editor controls.",
      );
      await this.command("open", { site: "gemini" });
      if (!this.current(id)) return;
      const view = await this.command("observe");
      if (!this.current(id)) return;
      await this.advance(view, id, true);
    });
    return this.snapshot();
  }
  async advance(view, id, initial = false) {
    if (!this.current(id)) return;
    delete this.value.input;
    if (view.kind === "signed_in" && view.site === "gemini") {
      this.update(
        initial ? "already_signed_in" : "signed_in",
        initial
          ? "Gemini's signed-in account and editor controls are visible. Already signed in; automation stopped without requesting credentials."
          : "Gemini's signed-in account and editor controls are visible. Sign-in automation stopped.",
      );
      return;
    }
    this.update(
      "awaiting_user",
      "Sign in manually in the opened Chrome window. Complete Google verification there, open Gemini, then choose Check again. The app never enters credentials or submits sign-in forms.",
    );
  }
  submit() {
    throw new Error(
      "Sign in directly in Chrome; app credential submission is disabled.",
    );
  }

  proceed(id) {
    if (
      id !== this.value.id ||
      !["awaiting_user", "needs_review", "awaiting_input"].includes(
        this.value.state,
      )
    )
      throw new Error("Stale flow");
    delete this.value.input;
    this.update(
      "checking_gemini",
      "Checking the current managed page without retyping or resubmitting previous input.",
    );
    this.run(async (current) => {
      const view = await this.command("observe");
      if (this.current(current)) await this.advance(view, current);
    });
    return this.snapshot();
  }
  confirm() {
    throw new Error(
      "Authentication must be observed, not manually marked verified",
    );
  }
  async cancel(id) {
    if (
      id !== this.value.id ||
      terminal.has(this.value.state) ||
      this.value.state === "cancelling"
    )
      throw new Error("No active flow");
    this.controller.abort();
    delete this.value.input;
    this.update(
      "cancelling",
      "Stopping the automation and its owned browser; the profile remains saved.",
    );
    await this.task;
    try {
      await this.action({ type: "stop" });
    } catch (error) {
      const diagnosed = actionError(error);
      this.update("failed", diagnosed.message);
      return this.snapshot();
    }
    this.update(
      "cancelled",
      "Automation and browser stopped. Saved profile retained.",
    );
    return this.snapshot();
  }
  interrupted() {
    if (!terminal.has(this.value.state) && this.value.state !== "cancelling") {
      this.controller?.abort();
      delete this.value.input;
      this.update(
        "interrupted",
        "Browser stopped. Start again to inspect Gemini using the saved profile.",
      );
    }
  }
}
