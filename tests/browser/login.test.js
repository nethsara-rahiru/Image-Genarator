import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { MongoMemoryServer } from "mongodb-memory-server";
import WebSocket from "ws";
import { connect, GoogleAccount, Lease } from "../../src/models/index.js";
import { AccountManager } from "../../src/services/accountManager.js";
import { BrowserManager } from "../../src/services/browserManager.js";
import { attachViewer } from "../../src/services/loginViewer.js";
import { storage } from "../../src/utils/files.js";
let browser, mongo, config;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri());
  browser = await chromium.launch();
  config = {
    DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "gemini-login-")),
    LEASE_MS: 5000,
  };
  await storage(config);
});
after(async () => {
  await browser.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(config.DATA_DIR, { recursive: true, force: true });
});
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Condition did not complete");
}
const signedOut = "<h1>Google fixture</h1><button>Sign in</button>";
const signedIn =
  '<rich-textarea><div contenteditable="true" class="ql-editor">Prompt</div></rich-textarea>';
async function route(page) {
  await page.route("https://gemini.google.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: signedOut }),
  );
  await page.route("https://accounts.google.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: signedOut }),
  );
}
async function setup(options = {}) {
  const account = await GoogleAccount.create({
    email: "login-fixture@example.test",
  });
  const browsers = new BrowserManager(config, {
    launch: async () => {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const p = await ctx.newPage();
      await route(p);
      return ctx;
    },
  });
  const accounts = new AccountManager(browsers, options);
  await accounts.login(account._id);
  return {
    account,
    browsers,
    accounts,
    session: accounts.logins.get(String(account._id)),
  };
}
test("failed verification preserves the login browser and later visible composer verifies", async () => {
  const t = await setup();
  try {
    const r = await t.accounts.verify(t.account._id);
    assert.equal(r.ready, false);
    assert.equal(r.active, true);
    assert.equal(t.session.page.isClosed(), false);
    assert.equal(
      (await GoogleAccount.findById(t.account._id)).state,
      "authenticating",
    );
    await t.session.page.setContent(signedIn);
    const verified = await t.accounts.verify(t.account._id);
    assert.equal(verified.ready, true);
    assert.equal(t.accounts.status(t.account._id).active, false);
    assert.equal(t.session.page.isClosed(), true);
    assert.equal((await GoogleAccount.findById(t.account._id)).state, "ready");
  } finally {
    await t.accounts.close();
    await t.browsers.close();
  }
});
test("Google popup becomes the active viewer page without losing the original login session", async () => {
  const t = await setup();
  try {
    const old = t.session.page;
    const popup = await t.session.context.newPage();
    await route(popup);
    await popup.goto("https://accounts.google.com/signin");
    await until(() => t.session.page === popup);
    await old.close();
    assert.equal(t.accounts.logins.get(String(t.account._id)).page, popup);
    assert.equal((await t.accounts.verify(t.account._id)).active, true);
    await popup.goto("https://gemini.google.com/app");
    await popup.setContent(signedIn);
    assert.equal((await t.accounts.verify(t.account._id)).ready, true);
  } finally {
    await t.accounts.close();
    await t.browsers.close();
  }
});
test("time-limited login expires and releases the profile lock", async () => {
  const t = await setup({ loginSessionMs: 500 });
  try {
    await until(() => !t.accounts.status(t.account._id).active);
    await until(
      async () =>
        (await GoogleAccount.findById(t.account._id)).state ===
        "login_required",
    );
    assert.equal(t.accounts.status(t.account._id).reason, "expired");
    await until(
      async () =>
        (await Lease.findById(`profile:${t.account._id}`)).expiresAt <=
        new Date(),
    );
    assert(t.session.page.isClosed());
  } finally {
    await t.accounts.close();
    await t.browsers.close();
  }
});
test("profile heartbeat loss closes the browser and reports a distinct reason", async () => {
  const t = await setup();
  try {
    await Lease.updateOne(
      { _id: `profile:${t.account._id}` },
      { $set: { owner: "replacement-owner" } },
    );
    await until(() => !t.accounts.status(t.account._id).active);
    assert.equal(t.accounts.status(t.account._id).reason, "profile_lease_lost");
    assert(t.session.page.isClosed());
  } finally {
    await t.accounts.close();
    await t.browsers.close();
  }
});
test("navigation screenshot failure keeps the stream alive; rapid input stays ordered; revoked auth closes it", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent("<input autofocus>");
  const original = page.screenshot.bind(page);
  let attempts = 0;
  page.screenshot = async (...args) => {
    if (++attempts === 1)
      throw new Error("Execution context destroyed by navigation");
    return original(...args);
  };
  const realInsert = page.keyboard.insertText.bind(page.keyboard);
  page.keyboard.insertText = async (v) => {
    await new Promise((r) => setTimeout(r, 30));
    return realInsert(v);
  };
  const id = "000000000000000000000001";
  const session = {
    accountId: id,
    page,
    expiresAt: new Date(Date.now() + 10000),
  };
  let revoked = false;
  const middleware = (req, res, next) => {
    req.session = {
      adminId: "fixture",
      csrf: "fixture",
      cookie: { expires: new Date(Date.now() + 10000) },
      reload: (cb) => cb(revoked ? new Error("revoked") : null),
    };
    next();
  };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `https://localhost:${server.address().port}`;
  const wss = attachViewer(
    server,
    middleware,
    { logins: new Map([[id, session]]) },
    { PUBLIC_ORIGIN: origin },
  );
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/viewer?account=${id}&csrf=fixture`,
    { headers: { Origin: origin } },
  );
  let frames = 0,
    notices = 0;
  ws.on("message", (bytes, binary) => {
    if (binary) frames++;
    else if (JSON.parse(bytes).type === "status") notices++;
  });
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await until(() => frames > 0 && notices > 0);
    assert.equal(ws.readyState, WebSocket.OPEN);
    for (const text of ["A", "B", "C"])
      ws.send(JSON.stringify({ type: "text", text }));
    await until(
      async () => (await page.locator("input").inputValue()) === "ABC",
    );
    const closed = new Promise((resolve) =>
      ws.once("close", (code) => resolve(code)),
    );
    revoked = true;
    assert.equal(await closed, 4001);
  } finally {
    ws.terminate();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((r) => server.close(r));
    await ctx.close();
  }
});
