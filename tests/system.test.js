import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import { configuration } from "../src/config.js";
import { writeAdmin } from "../src/admin.js";
async function rawRequest(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method, headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            for (const item of Array.isArray(value) ? value : [value])
              if (item !== undefined) headers.append(key, item);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers,
            }),
          );
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
const password = "correct test password 123";
async function harness(t, { secure = false } = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "remote-system-"));
  await writeAdmin(data, "admin", password);
  const fixture = http.createServer((req, res) => {
    if (req.url === "/file") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": 'attachment; filename="example.txt"',
      });
      res.end("original test download");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Fixture browser</title><style>body{margin:20px}input{padding:10px;display:block;margin:15px}</style><h1>Remote fixture</h1><input id="field" aria-label="Test input"><input id="file" type="file"><a id="download" href="/file" download>Download</a><a id="popup" href="/second" target="_blank">New tab</a>',
    );
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  const config = { ...configuration({ DATA_DIR: data }), port: 0, secure };
  const service = await startServer(config, {
    test: true,
    validateUrl: async (url) => {
      if (!url.startsWith(`${fixtureBase}/`))
        throw new Error("Blocked in fixture");
      return url;
    },
  });
  const base = `http://127.0.0.1:${service.port}`;
  config.origin = secure ? "https://browser.example" : base;
  config.secure = secure;
  t.after(async () => {
    await service.close();
    await new Promise((r) => fixture.close(r));
    await fs.rm(data, { recursive: true, force: true });
  });
  const headers = {
    Host: new URL(config.origin).host,
    ...(secure ? { "X-Forwarded-Proto": "https" } : {}),
  };
  let cookie = "",
    csrf = "";
  async function request(endpoint, method = "GET", body, extra = {}) {
    const res = await rawRequest(`${base}${endpoint}`, {
      method,
      headers: {
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET"
          ? { Origin: config.origin, "X-CSRF-Token": csrf }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(";")[0];
    return res;
  }
  async function bootstrap() {
    const res = await request("/api/session");
    csrf = (await res.json()).csrf;
  }
  async function login() {
    await bootstrap();
    const res = await request("/api/login", "POST", {
      username: "admin",
      password,
    });
    assert.equal(res.status, 200);
    csrf = (await res.json()).csrf;
  }
  return {
    service,
    base,
    fixtureBase,
    config,
    request,
    bootstrap,
    login,
    cookie: () => cookie,
    csrf: () => csrf,
  };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error("Condition timed out");
}
test("HTTP authentication, CSRF, exact host/origin, session reset and download isolation", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("/api/state")).status, 401);
  assert.equal(
    (await h.request("/api/session", "GET", null, { Host: "evil.example" }))
      .status,
    403,
  );
  await h.bootstrap();
  assert.equal(
    (
      await h.request(
        "/api/login",
        "POST",
        { username: "admin", password },
        { Origin: "http://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request("/api/login", "POST", {
        username: "admin",
        password: "wrong",
      })
    ).status,
    401,
  );
  await h.login();
  assert.equal(
    (
      await h.request(
        "/api/action",
        "POST",
        { type: "start" },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal((await h.request("/api/state")).status, 200);
  assert.equal((await h.request("/api/downloads/..%2fadmin.json")).status, 404);
  await writeAdmin(h.config.data, "admin", "a completely new password", true);
  assert.equal((await h.request("/api/state")).status, 401);
});
test("HTTPS reverse proxy requires encrypted transport and issues Secure cookies", async (t) => {
  const h = await harness(t, { secure: true });
  const bad = await h.request("/api/session", "GET", null, {
    "X-Forwarded-Proto": "http",
  });
  assert.equal(bad.status, 403);
  const good = await h.request("/api/session");
  assert.equal(good.status, 200);
  assert.match(good.headers.get("set-cookie"), /; Secure/);
});
test("login rate limiting bounds repeated incorrect passwords", async (t) => {
  const h = await harness(t);
  await h.bootstrap();
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await h.request("/api/login", "POST", {
          username: "admin",
          password: "wrong",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await h.request("/api/login", "POST", {
        username: "admin",
        password: "wrong",
      })
    ).status,
    429,
  );
});
test("real Chromium: navigation, input, tabs, file upload, original download and profile persistence", async (t) => {
  const h = await harness(t);
  const b = h.service.browser;
  await b.start();
  await b.action({ type: "navigate", url: `${h.fixtureBase}/` });
  assert.equal((await b.state()).tabs.length, 1);
  const rect = await b.page().locator("#field").boundingBox();
  await b.action({ type: "click", x: rect.x + 5, y: rect.y + 5 });
  await b.action({ type: "text", text: "hello remote browser" });
  assert.equal(
    await b.page().locator("#field").inputValue(),
    "hello remote browser",
  );
  await b.action({ type: "key", key: "Control+A" });
  await b.action({ type: "text", text: "replacement" });
  assert.equal(await b.page().locator("#field").inputValue(), "replacement");
  const image = await b.page().screenshot({ type: "jpeg" });
  assert.equal(image.subarray(0, 2).toString("hex"), "ffd8");
  const original = b.activeId;
  await b.action({ type: "newTab" });
  assert.equal(b.pages.size, 2);
  await b.action({ type: "closeTab", id: b.activeId });
  assert.equal(b.activeId, original);
  await b.page().locator("#file").click();
  await until(() => b.pending);
  await b.upload({
    originalname: "reference.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("reference content"),
  });
  assert.equal(
    await b
      .page()
      .locator("#file")
      .evaluate((e) => e.files[0].name),
    "reference.txt",
  );
  await assert.rejects(b.upload({}));
  await b.page().locator("#download").click();
  await until(async () => (await b.downloads()).length === 1);
  const record = (await b.downloads())[0];
  assert.equal(
    await fs.readFile((await b.download(record.id)).path, "utf8"),
    "original test download",
  );
  await h.login();
  const download = await h.request(`/api/downloads/${record.id}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "original test download");
  await assert.rejects(
    b.action({ type: "navigate", url: "http://169.254.169.254/" }),
  );
  await assert.rejects(b.action({ type: "key", key: "javascript:alert(1)" }));
  await assert.rejects(b.action({ type: "click", x: -1, y: 0 }));
  await b.context.addCookies([
    {
      name: "persistent",
      value: "session",
      url: h.fixtureBase,
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
  await b.stop();
  await b.start();
  assert.equal(
    (await b.context.cookies(h.fixtureBase)).some(
      (c) => c.name === "persistent",
    ),
    true,
  );
  await h.request("/api/logout", "POST");
  assert.equal(b.context, null);
  assert.equal((await h.request("/api/state")).status, 401);
});
test("WebSocket stream requires a session and exact origin; reset revokes an open viewer", async (t) => {
  const h = await harness(t);
  await h.login();
  const address = h.base.replace("http:", "ws:") + "/stream";
  const anonymous = new WebSocket(address, {
    headers: { Origin: h.config.origin },
  });
  await new Promise((resolve, reject) => {
    anonymous.once("error", resolve);
    anonymous.once("open", () => {
      anonymous.close();
      reject(new Error("Anonymous viewer accepted"));
    });
  });
  const denied = new WebSocket(address, {
    headers: { Origin: "http://evil.example", Cookie: h.cookie() },
  });
  await new Promise((resolve) => {
    denied.once("error", resolve);
    denied.once("open", () => {
      denied.close();
      assert.fail("Foreign origin accepted");
    });
  });
  const ws = new WebSocket(address, {
    headers: { Origin: h.config.origin, Cookie: h.cookie() },
  });
  const initial = await new Promise((resolve, reject) => {
    ws.on("message", (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type === "state") resolve(message);
      }
    });
    ws.once("error", reject);
  });
  assert.equal(initial.type, "state");
  const closed = new Promise((resolve) =>
    ws.once("close", (code) => resolve(code)),
  );
  await writeAdmin(
    h.config.data,
    "admin",
    "new revoked session password",
    true,
  );
  assert.equal(await closed, 4001);
});
test("responsive dashboard signs in, streams real frames and controls remote text input", async (t) => {
  const h = await harness(t);
  const client = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
  });
  t.after(() => client.close());
  const page = await client.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(h.base);
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("#start").waitFor({ state: "visible" });
  await page.locator("#start").click();
  await page.waitForFunction(
    () => !document.querySelector("#address").disabled,
  );
  await page.locator("#address").fill(`${h.fixtureBase}/`);
  await page.locator("#go").click();
  await h.service.browser.page().locator("#field").waitFor();
  const remote = await h.service.browser.page().locator("#field").boundingBox();
  const canvas = page.locator("#screen");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  await canvas.click({
    position: {
      x: ((remote.x + 10) * box.width) / 1280,
      y: ((remote.y + 10) * box.height) / 800,
    },
  });
  await page.keyboard.type("typed from local browser");
  await until(
    async () =>
      (await h.service.browser.page().locator("#field").inputValue()) ===
      "typed from local browser",
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("#screen")
        .getContext("2d")
        .getImageData(20, 20, 1, 1).data[3] === 255,
  );
  await page
    .getByRole("button", { name: "Debug console", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#debug-output")
      .textContent.includes("ACTION_COMPLETED"),
  );
  await page.locator("#debug-filter").fill("ACTION_COMPLETED");
  assert.match(
    await page.locator("#debug-output").textContent(),
    /ACTION_COMPLETED/,
  );
  await page.locator("#debug-filter").fill("");
  await page.locator("#debug-pause").click();
  const frozen = await page.locator("#debug-output").textContent();
  h.service.log.write(
    "info",
    "server",
    "UI_TEST_EVENT",
    "Synthetic viewer diagnostic.",
  );
  await page.waitForFunction(() =>
    document.querySelector("#debug-status").textContent.includes("paused"),
  );
  assert.equal(await page.locator("#debug-output").textContent(), frozen);
  await page.locator("#debug-pause").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#debug-output")
      .textContent.includes("UI_TEST_EVENT"),
  );
  const exported = page.waitForEvent("download");
  await page.locator("#debug-export").click();
  const artifact = await exported;
  const exportedJson = await fs.readFile(await artifact.path(), "utf8");
  assert.match(exportedJson, /UI_TEST_EVENT/);
  assert.doesNotMatch(exportedJson, /typed from local browser/);
  const googleTargets = [];
  const originalValidator = h.service.browser.validateUrl;
  h.service.browser.validateUrl = async (url) => {
    if (url.startsWith("https://www.google.com/")) {
      googleTargets.push(url);
      return `${h.fixtureBase}/google-fixture`;
    }
    return originalValidator(url);
  };
  await page.locator("#address").fill("browser search example");
  await page.locator("#go").click();
  await until(() =>
    googleTargets.includes(
      "https://www.google.com/search?q=browser%20search%20example",
    ),
  );
  await page.locator("#google").click();
  await until(() => googleTargets.includes("https://www.google.com/"));
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/remote-browser-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/remote-browser-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#login-panel").waitFor({ state: "visible" });
});
test("revoked sessions cannot execute actions already waiting in the input queue", async (t) => {
  const h = await harness(t);
  await h.login();
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (entered = resolve));
  const performed = [];
  h.service.browser.action = async (d) => {
    performed.push(d.type);
    if (d.type === "first") {
      entered();
      await gate;
    }
  };
  const first = h.request("/api/action", "POST", { type: "first" });
  await started;
  const second = h.request("/api/action", "POST", { type: "second" });
  await pause(50);
  await writeAdmin(h.config.data, "admin", "reset while queued password", true);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 400);
  assert.deepEqual(performed, ["first"]);
});
test("authenticated startup failures return a safe actionable diagnostic", async (t) => {
  const h = await harness(t);
  await h.login();
  h.service.browser.launch = async () => {
    throw new Error(
      "Executable doesn't exist at /private/user/browser secret=hidden",
    );
  };
  const res = await h.request("/api/action", "POST", { type: "start" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "BROWSER_MISSING");
  assert.match(body.error, /playwright install/);
  assert.doesNotMatch(body.error, /secret=hidden|\/private\/user/);
});
test("debug API is authenticated, replayable, exportable, CSRF-protected and omits action text", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("/api/logs")).status, 401);
  assert.equal((await h.request("/api/logs/export")).status, 401);
  await h.login();
  h.service.browser.action = async () => {
    throw new Error(
      "net::ERR_NAME_NOT_RESOLVED https://private.example/?token=do-not-log",
    );
  };
  const failed = await h.request("/api/action", "POST", {
    type: "navigate",
    url: "https://example.com/?secret=never-record",
  });
  const result = await failed.json();
  assert.equal(result.code, "DNS_FAILED");
  assert.ok(result.debugId);
  const logs = await (await h.request("/api/logs")).json();
  const entry = logs.entries.find(
    (e) => e.details.actionId === result.debugId && e.level === "error",
  );
  assert.equal(entry.code, "DNS_FAILED");
  const replay = await (
    await h.request(`/api/logs?after=${encodeURIComponent(logs.cursor)}`)
  ).json();
  assert.equal(replay.entries.length, 0);
  const onlyErrors = await (await h.request("/api/logs?level=error")).json();
  assert.ok(onlyErrors.entries.every((e) => e.level === "error"));
  const exported = await h.request("/api/logs/export");
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  const text = await exported.text();
  assert.doesNotMatch(text, /do-not-log|never-record/);
  assert.equal(
    (await h.request("/api/logs", "DELETE", null, { "X-CSRF-Token": "wrong" }))
      .status,
    403,
  );
  const cleared = await (await h.request("/api/logs", "DELETE")).json();
  assert.equal(cleared.entries.length, 1);
  assert.equal(cleared.entries[0].code, "LOG_CLEARED");
});
test("Google search and shortcut navigate the remote browser through the normal destination checks", async (t) => {
  const h = await harness(t);
  const b = h.service.browser;
  const seen = [];
  const original = b.validateUrl;
  b.validateUrl = async (url) => {
    if (url.startsWith("https://www.google.com/")) {
      seen.push(url);
      return `${h.fixtureBase}/google-fixture`;
    }
    return original(url);
  };
  await b.start();
  await b.action({ type: "navigate", url: "test private search query" });
  assert.ok(
    seen.includes(
      "https://www.google.com/search?q=test%20private%20search%20query",
    ),
  );
  await b.action({ type: "navigate", url: "https://www.google.com/" });
  assert.ok(seen.includes("https://www.google.com/"));
  assert.doesNotMatch(
    JSON.stringify(h.service.log.snapshot()),
    /private search query|private%20search/,
  );
});
