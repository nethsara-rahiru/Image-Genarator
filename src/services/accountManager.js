import { GoogleAccount } from "../models/index.js";
import { signedIn } from "./browserManager.js";
import { AppError } from "../utils/errors.js";
import { emit } from "./eventService.js";
const reasons = {
  expired: "Login session expired",
  verified: "Signed-in UI verified",
  cancelled: "Login session closed by administrator",
  browser_closed: "Login browser stopped",
  profile_lease_lost: "Login browser lost its profile lease",
  shutdown: "API shutting down",
};
export class AccountManager {
  constructor(browsers, { loginSessionMs = 900000 } = {}) {
    this.browsers = browsers;
    this.loginSessionMs = loginSessionMs;
    this.logins = new Map();
    this.ended = new Map();
  }
  status(id) {
    const s = this.logins.get(String(id));
    return s
      ? {
          active: true,
          expiresAt: s.expiresAt,
          remainingMs: Math.max(0, s.expiresAt - Date.now()),
        }
      : { active: false, reason: this.ended.get(String(id)) || "closed" };
  }
  async login(id) {
    const key = String(id);
    if (this.logins.has(key))
      throw new AppError("PROFILE_BUSY", "Login already active", 409);
    const session = await this.browsers.open(id, { login: true });
    try {
      await GoogleAccount.findByIdAndUpdate(id, { state: "authenticating" });
      session.expiresAt = new Date(Date.now() + this.loginSessionMs);
      session.timer = setTimeout(
        () => this.finish(key, false, "expired").catch(() => {}),
        this.loginSessionMs,
      );
      session.timer.unref();
      this.logins.set(key, session);
      this.ended.delete(key);
      session.context?.once?.("close", () => {
        if (this.logins.get(key) === session)
          this.finish(
            key,
            false,
            session.closeReason || "browser_closed",
          ).catch(() => {});
      });
      await emit("account.login", "Interactive login started", {
        accountId: id,
      });
      return {
        viewerUrl: `/viewer.html?account=${id}`,
        expiresAt: session.expiresAt,
      };
    } catch (e) {
      if (this.logins.has(key))
        await this.finish(key, false, "browser_closed").catch(() => {});
      else await session.close().catch(() => {});
      throw e;
    }
  }
  async finish(id, verify = true, reason = "cancelled") {
    const key = String(id);
    const s = this.logins.get(key);
    if (!s) throw new AppError("LOGIN_SESSION", "No active login session", 404);
    if (verify && s.expiresAt <= new Date())
      return this.finish(id, false, "expired");
    let ready = false;
    if (verify) {
      ready = await signedIn(s.page).catch(() => false);
      if (!ready) {
        await emit(
          "account.verification_pending",
          "Sign-in not yet verified; login browser remains open",
          { accountId: id },
        );
        return {
          ready: false,
          ...this.status(key),
          message:
            "Sign-in is not ready yet. Complete Google sign-in, open Gemini, and verify again. Your browser remains open.",
        };
      }
      reason = "verified";
    }
    clearTimeout(s.timer);
    this.logins.delete(key);
    this.ended.set(key, reason);
    if (this.ended.size > 200)
      this.ended.delete(this.ended.keys().next().value);
    try {
      await s.close(reason);
    } finally {
      await GoogleAccount.findByIdAndUpdate(id, {
        state: ready ? "ready" : "login_required",
        ...(verify ? { lastVerified: new Date() } : {}),
      });
    }
    await emit(
      "account.login_ended",
      reasons[reason] || reasons.browser_closed,
      { accountId: id },
    );
    return { ready, active: false, reason };
  }
  async verify(id) {
    if (this.logins.has(String(id))) return this.finish(id);
    const s = await this.browsers.open(id);
    try {
      const ready = await signedIn(s.page);
      await GoogleAccount.findByIdAndUpdate(id, {
        state: ready ? "ready" : "login_required",
        lastVerified: new Date(),
      });
      return { ready, active: false };
    } finally {
      await s.close();
    }
  }
  async openGemini(id) {
    const s = this.logins.get(String(id));
    if (!s) throw new AppError("LOGIN_SESSION", "No active login session", 404);
    if (s.expiresAt <= new Date()) {
      await this.finish(id, false, "expired");
      throw new AppError("LOGIN_SESSION", "Login session expired", 410);
    }
    await s.page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    return this.status(id);
  }
  async close() {
    for (const id of this.logins.keys())
      await this.finish(id, false, "shutdown");
  }
}
