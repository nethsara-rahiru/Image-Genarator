import path from "node:path";
import { chromium } from "playwright";
import { LockManager } from "./jobQueue.js";
import { GoogleAccount } from "../models/index.js";
import { AppError } from "../utils/errors.js";
import { safePath } from "../utils/files.js";
export function allowedNavigation(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      [
        "gemini.google.com",
        "accounts.google.com",
        "myaccount.google.com",
        "consent.google.com",
      ].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export async function signedIn(page) {
  return (
    new URL(page.url()).hostname === "gemini.google.com" &&
    (await page
      .locator(
        '[contenteditable="true"][role="textbox"],rich-textarea [contenteditable="true"],.ql-editor[contenteditable="true"],textarea[aria-label*="prompt" i]',
      )
      .filter({ visible: true })
      .count()) > 0 &&
    (await page.getByRole("link", { name: /sign in/i }).count()) === 0 &&
    (await page.getByRole("button", { name: /^sign in$/i }).count()) === 0
  );
}
export class BrowserManager {
  constructor(
    config,
    { launch = chromium.launchPersistentContext.bind(chromium) } = {},
  ) {
    this.config = config;
    this.launch = launch;
    this.sessions = new Map();
  }
  async open(accountId, { login = false } = {}) {
    const id = String(accountId);
    const account = await GoogleAccount.findById(id);
    if (!account || account.disabled)
      throw new AppError("ACCOUNT", "Account unavailable");
    const locks = new LockManager(undefined, this.config.LEASE_MS);
    if (!(await locks.acquire(`profile:${id}`)))
      throw new AppError("PROFILE_BUSY", "Account profile is in use", 409);
    let context;
    let timer;
    try {
      context = await this.launch(
        safePath(path.join(this.config.DATA_DIR, "profiles"), id),
        {
          headless: true,
          locale: "en-US",
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
          permissions: [],
        },
      );
      await context.route("**/*", async (route) => {
        const r = route.request();
        if (
          r.isNavigationRequest() &&
          r.frame() === r.frame().page().mainFrame() &&
          !allowedNavigation(r.url())
        )
          return route.abort("blockedbyclient");
        return route.continue();
      });
      const page = context.pages()[0] || (await context.newPage());
      let closePromise;
      const session = {
        context,
        page,
        locks,
        login,
        accountId: id,
        close: (reason = "browser_closed") => {
          session.closeReason ??= reason;
          if (!closePromise)
            closePromise = (async () => {
              clearInterval(timer);
              await context.close().catch(() => {});
              await locks.release(`profile:${id}`);
              this.sessions.delete(id);
            })();
          return closePromise;
        },
      };
      context.once("close", () => {
        session.closed = true;
        session.close().catch(() => {});
      });
      if (login) {
        const follow = (candidate) => {
          const adopt = () => {
            if (!candidate.isClosed() && allowedNavigation(candidate.url()))
              session.page = candidate;
          };
          candidate.on("domcontentloaded", adopt);
          candidate.on("close", () => {
            if (session.page === candidate) {
              const fallback = context
                .pages()
                .find((p) => !p.isClosed() && allowedNavigation(p.url()));
              if (fallback) session.page = fallback;
            }
          });
          adopt();
        };
        context.on("page", follow);
        follow(page);
      }
      timer = setInterval(
        () =>
          locks
            .heartbeat(`profile:${id}`)
            .catch(() => session.close("profile_lease_lost").catch(() => {})),
        Math.floor(this.config.LEASE_MS / 3),
      );
      timer.unref();
      this.sessions.set(id, session);
      await page.goto("https://gemini.google.com/app", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      return session;
    } catch (e) {
      clearInterval(timer);
      if (context) await context.close().catch(() => {});
      await locks.release(`profile:${id}`);
      throw e;
    }
  }
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}
