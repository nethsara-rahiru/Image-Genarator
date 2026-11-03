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
    if (
      view.kind === "signed_out" &&
      view.site === "gemini" &&
      !this.loginOpened
    ) {
      this.loginOpened = true;
      this.update(
        "opening_google",
        "Gemini shows signed-out controls. Opening Google sign-in.",
      );
      await this.command("open", { site: "google" });
      if (!this.current(id)) return;
      return this.advance(await this.command("observe"), id);
    }
    if (
      view.site === "google" &&
      ["email", "password", "verification"].includes(view.kind)
    ) {
      this.value.input = {
        kind: view.kind,
        token: randomUUID(),
        label: {
          email: "Google email or username",
          password: "Google password",
          verification: "Verification code requested by Google",
        }[view.kind],
      };
      this.update(
        "awaiting_input",
        view.error
          ? "Google reports an input error. Check its message in the browser and enter the requested detail again."
          : `Google is requesting ${view.kind === "email" ? "your email or username" : view.kind === "password" ? "your password" : "a verification code"}. Enter it in the system dialog; it is not saved.`,
      );
      return;
    }
    if (view.kind === "account_chooser" && !this.usedChooser) {
      const candidates = view.candidates.filter((c) => c.action === "another");
      if (candidates.length === 1) {
        this.usedChooser = true;
        await this.command("click", { candidate: candidates[0] });
        if (!this.current(id)) return;
        return this.advance(
          await this.command("observe", { options: { previous: view } }),
          id,
        );
      }
    }
    if (
      view.kind === "security_check" ||
      view.kind === "blocked" ||
      view.site === "blocked"
    ) {
      this.update(
        "awaiting_user",
        "Google needs an interactive security step, rejects the browser, or navigation left the allowed sign-in sites. Complete the legitimate step in the live browser, then choose Check again. Security checks will not be bypassed.",
      );
      return;
    }
    if (this.recovery && this.attempts < 2) {
      this.attempts++;
      this.update(
        "recovering",
        "The page step is unknown. Trying bounded Groq recovery using sanitized navigation candidates only.",
      );
      const proposal = await this.recovery.propose(
        view,
        this.controller.signal,
      );
      if (!this.current(id)) return;
      if (proposal.operation === "click") {
        const candidate = view.candidates.find(
          (c) =>
            c.id === proposal.candidateId &&
            ["signin", "another"].includes(c.action),
        );
        if (candidate) {
          await this.command("click", { candidate });
          if (!this.current(id)) return;
          return this.advance(
            await this.command("observe", { options: { previous: view } }),
            id,
          );
        }
      } else if (proposal.operation === "wait") {
        return this.advance(
          await this.command("observe", { options: { previous: view } }),
          id,
        );
      }
    }
    this.update(
      "awaiting_user",
      "The page state could not be verified safely. Inspect the live browser, configure Groq if needed, complete the requested step, then choose Check again. No credentials were guessed or submitted.",
    );
  }
  submit(id, token, value) {
    if (
      id !== this.value.id ||
      this.value.state !== "awaiting_input" ||
      token !== this.value.input?.token ||
      typeof value !== "string" ||
      !value.length ||
      value.length > 1000
    )
      throw new Error("Stale input");
    const kind = this.value.input.kind;
    delete this.value.input;
    this.update(
      "submitting_input",
      "Entering the requested detail into the verified Google field and submitting Next once.",
    );
    this.run(async (current) => {
      const view = await this.command("fill", { kind, value });
      if (this.current(current)) await this.advance(view, current);
    });
    return this.snapshot();
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
