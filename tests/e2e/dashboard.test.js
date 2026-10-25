import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import argon2 from "argon2";
import {
  connect,
  AdminUser,
  GenerationJob,
  GoogleAccount,
  GeminiChat,
} from "../../src/models/index.js";
import { createApp } from "../../src/app.js";
import { AccountManager } from "../../src/services/accountManager.js";
import { attachViewer } from "../../src/services/loginViewer.js";
import WebSocket from "ws";
import { storage } from "../../src/utils/files.js";
let mongo,
  browser,
  server,
  config,
  folder,
  origin,
  sessionStore,
  accounts,
  viewers;
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-e2e-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(folder, "key.pem"),
      "-out",
      path.join(folder, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri());
  config = {
    MONGODB_URI: mongo.getUri(),
    SESSION_SECRET: "x".repeat(40),
    DATA_DIR: folder,
    PUBLIC_ORIGIN: "https://localhost",
    GROQ_API_KEY: "",
    GROQ_MODEL: "test",
  };
  await storage(config);
  await AdminUser.create({
    username: "admin",
    passwordHash: await argon2.hash("testpassword123456"),
  });
  accounts = new AccountManager({
    open: async (accountId) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route("https://gemini.google.com/**", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: '<h1>Local login fixture</h1><div contenteditable="true" role="textbox">Fixture composer</div>',
        }),
      );
      await page.goto("https://gemini.google.com/app");
      return {
        page,
        context,
        accountId: String(accountId),
        close: () => context.close(),
      };
    },
  });
  const built = createApp(config, accounts);
  const { app } = built;
  sessionStore = built.sessionStore;
  server = https.createServer(
    {
      key: await fs.readFile(path.join(folder, "key.pem")),
      cert: await fs.readFile(path.join(folder, "cert.pem")),
    },
    app,
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `https://localhost:${server.address().port}`;
  config.PUBLIC_ORIGIN = origin;
  browser = await chromium.launch();
  viewers = attachViewer(server, built.sessionMiddleware, accounts, config);
});
after(async () => {
  await accounts?.close();
  for (const ws of viewers?.clients || []) ws.terminate();
  viewers?.close();
  await browser?.close();
  server?.closeAllConnections();
  await Promise.race([
    new Promise((r) => server?.close(r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  await sessionStore?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(folder, { recursive: true, force: true });
});
test("real HTTPS dashboard login, all pages, account create, queue submit and responsive layout", async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  await p.locator("[name=username]").fill("admin");
  await p.locator("[name=password]").fill("testpassword123456");
  await p.getByRole("button", { name: "Sign in securely" }).click();
  await p.getByRole("heading", { name: "System status" }).waitFor();
  for (const [hash, title] of [
    ["accounts", "Accounts"],
    ["chats", "Chats"],
    ["jobs", "Jobs & queue"],
    ["outputs", "Outputs"],
    ["monitor", "Browser monitor"],
    ["recovery", "AI recovery"],
    ["settings", "Settings"],
  ]) {
    await p.locator(`nav a[href="#${hash}"]`).click();
    await p.locator("h1").filter({ hasText: title }).waitFor();
    await p.waitForFunction(
      () => document.querySelector("#content").innerHTML.length > 100,
    );
    assert.equal(await p.locator("#notice").innerText(), "");
  }
  await p.locator('nav a[href="#accounts"]').click();
  await p.locator("#add-account [name=email]").fill("ui-fixture@example.test");
  await p.getByRole("button", { name: "Add account", exact: true }).click();
  await p.getByText("ui-fixture@example.test", { exact: true }).waitFor();
  await p.waitForFunction(() =>
    document
      .querySelector("#connection")
      .textContent.includes("Live connection"),
  );
  const popupPromise = p.waitForEvent("popup");
  await p.getByRole("button", { name: "Connect / reconnect" }).click();
  const viewer = await popupPromise;
  await viewer.waitForURL("**/viewer.html?account=*");
  await viewer.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Connected"),
  );
  await viewer.waitForFunction(
    () =>
      document.querySelector("canvas").getContext("2d").getImageData(0, 0, 1, 1)
        .data[3] > 0,
  );
  const loginSession = [...accounts.logins.values()][0];
  await loginSession.page.setContent("<button>Sign in</button>");
  await viewer.getByRole("button", { name: "Verify & finish" }).click();
  await viewer
    .locator("#verification-status")
    .filter({ hasText: "Your browser remains open" })
    .waitFor();
  assert.equal(loginSession.page.isClosed(), false);
  const originalScreenshot = loginSession.page.screenshot.bind(
    loginSession.page,
  );
  let captureFailure = true;
  loginSession.page.screenshot = async (...args) => {
    if (captureFailure) {
      captureFailure = false;
      throw new Error("Navigation interrupted capture");
    }
    return originalScreenshot(...args);
  };
  for (const socket of viewers.clients) socket.terminate();
  await viewer.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Reconnecting"),
  );
  await viewer.waitForFunction(
    () =>
      document.querySelector("#status").textContent.startsWith("Connected") &&
      document.querySelector("canvas").getContext("2d").getImageData(0, 0, 1, 1)
        .data[3] > 0,
  );
  assert.equal([...accounts.logins.values()][0], loginSession);
  await viewer
    .getByRole("button", { name: "Open Gemini", exact: true })
    .click();
  await viewer
    .locator("#verification-status")
    .filter({ hasText: "Gemini opened" })
    .waitFor();
  await viewer.getByRole("button", { name: "Verify & finish" }).click();
  await viewer
    .getByText("Signed-in UI verified. You can close this tab.")
    .waitFor();
  await viewer.close();
  const account = await GoogleAccount.findOne({
    email: "ui-fixture@example.test",
  });
  await GeminiChat.create({
    accountId: account._id,
    title: "Saved fixture conversation",
    status: "active",
    url: "https://gemini.google.com/app/reopenFixture",
  });
  await p.locator('nav a[href="#chats"]').click();
  const remotePromise = p.waitForEvent("popup");
  await p.getByRole("button", { name: "Open remote browser" }).click();
  const remote = await remotePromise;
  await remote.waitForURL("**/viewer.html?account=*");
  await remote.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Connected"),
  );
  assert.equal(
    accounts.logins.get(String(account._id)).page.url(),
    "https://gemini.google.com/app/reopenFixture",
  );
  await remote.getByRole("button", { name: "Verify & finish" }).click();
  await remote
    .getByText("Signed-in UI verified. You can close this tab.")
    .waitFor();
  await remote.close();

  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(
      origin.replace("https:", "wss:") +
        "/viewer?account=000000000000000000000000&csrf=bad",
      {
        rejectUnauthorized: false,
        headers: { Origin: "https://evil.example" },
      },
    );
    ws.on("open", () => {
      ws.close();
      resolve(false);
    });
    ws.on("error", () => resolve(true));
  });
  assert(rejected);
  await p.locator('nav a[href="#generator"]').click();
  await p
    .locator("#generate [name=accountId]")
    .selectOption({ label: "ui-fixture@example.test" });
  await p.locator("#generate [name=prompt]").fill("A fixture image");
  let dropFirst = true;
  await p.route("**/api/generate", async (route) => {
    if (dropFirst) {
      dropFirst = false;
      await route.fetch();
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UPSTREAM",
            message: "Response lost after submission",
          },
        }),
      });
    } else await route.continue();
  });
  await p.getByRole("button", { name: "Queue generation" }).click();
  await p.waitForFunction(
    () =>
      document.querySelector("#notice").textContent.length > 0 &&
      !document.querySelector("#generate button").disabled,
  );
  assert.equal(
    await GenerationJob.countDocuments({ prompt: "A fixture image" }),
    1,
  );
  await p.getByRole("button", { name: "Queue generation" }).click();
  await p
    .locator("#job-progress .badge")
    .filter({ hasText: "queued" })
    .waitFor();
  assert.equal(
    await GenerationJob.countDocuments({ prompt: "A fixture image" }),
    1,
  );
  await p.setViewportSize({ width: 390, height: 844 });
  for (const hash of [
    "overview",
    "generator",
    "accounts",
    "chats",
    "jobs",
    "outputs",
    "monitor",
    "recovery",
    "settings",
  ]) {
    await p.goto(`${origin}/#${hash}`);
    await p.locator("nav").waitFor();
    await p.waitForFunction(
      () => document.querySelector("#content").innerHTML.length > 100,
    );
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `horizontal overflow on ${hash}`,
    );
  }
  assert.deepEqual(errors, []);
  await fs.mkdir("/tmp/gemini-artifacts", { recursive: true });
  await p.goto(`${origin}/#overview`);
  await p.getByRole("heading", { name: "System status" }).waitFor();
  await p.screenshot({
    path: "/tmp/gemini-artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.screenshot({
    path: "/tmp/gemini-artifacts/dashboard-desktop.png",
    fullPage: true,
  });
  const cookies = await context.cookies();
  const auth = cookies.find((c) => c.name === "gemini.sid");
  assert(auth.secure && auth.httpOnly && auth.sameSite === "Strict");
  await context.close();
});
