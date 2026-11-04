import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { GOOGLE_LOGIN, GEMINI_URL } from "../src/geminiFlow.js";
import { startServer } from "../src/server.js";
import { configuration } from "../src/config.js";
import { writeAdmin } from "../src/admin.js";
import { RemoteBrowser } from "../src/browser.js";
import { startBrowserProxy } from "../src/native/proxy.js";
import {
  browserArguments,
  validKey,
  jpegDimensions,
  run,
  chromeExecutable,
  launchFailure,
} from "../src/native/common.js";
import WebSocket from "ws";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const password = "native test administrator password";
async function eventually(fn, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error("Condition timed out");
}
async function harness(t, options = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "native-system-"));
  await writeAdmin(data, "admin", password);
  const config = {
    ...configuration({
      DATA_DIR: data,
      AUTO_OPEN: "false",
      AUTH_REQUIRED: "true",
    }),
    port: 0,
  };
  const service = await startServer(config, { test: true, ...options });
  const base = `http://127.0.0.1:${service.port}`;
  config.origin = base;
  t.after(async () => {
    await service.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  async function request(endpoint, method = "GET", body, extra = {}) {
    const res = await fetch(base + endpoint, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET" ? { Origin: base, "X-CSRF-Token": csrf } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(";")[0];
    return res;
  }
  async function login() {
    csrf = (await (await request("/api/session")).json()).csrf;
    const res = await request("/api/login", "POST", {
      username: "admin",
      password,
    });
    assert.equal(res.status, 200);
    csrf = (await res.json()).csrf;
  }
  return { data, config, service, base, request, login, cookie: () => cookie };
}
test("native browser launch arguments keep desktop mode and exclude automation/debugging flags", () => {
  const args = browserArguments("/private/profile", 1234);
  assert.ok(args.includes("--new-window"));
  assert.match(args.join(" "), /proxy-server/);
  assert.doesNotMatch(
    args.join(" "),
    /--headless|enable-automation|remote-debugging|disable-blink|no-sandbox/,
  );
  assert.ok(validKey("Meta+Shift+G"));
  assert.ok(validKey("Control+L"));
  assert.equal(validKey("Execute+shell"), false);
});
test("OS detection supports normal installed executables and rejects missing/unsupported hosts", async () => {
  await assert.rejects(
    chromeExecutable("unsupported"),
    (e) => e.code === "OS_UNSUPPORTED",
  );
  await assert.rejects(
    chromeExecutable(process.platform, "/definitely/no/browser"),
    (e) => e.code === "CHROME_NOT_INSTALLED",
  );
});
test("authentication, CSRF, password revocation and private log export remain enforced", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("/api/state")).status, 401);
  assert.equal((await h.request("/api/gemini-flow")).status, 401);
  assert.equal((await h.request("/api/automation/settings")).status, 401);
  assert.equal((await h.request("/api/logs/export")).status, 401);
  await h.login();
  assert.equal(
    (
      await h.request(
        "/api/action",
        "POST",
        { type: "start" },
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  assert.equal((await h.request("/api/state")).status, 200);
  const settings = await h.request("/api/automation/settings", "POST", {
    key: "synthetic-api-key",
    model: "test-model",
  });
  assert.equal(settings.status, 200);
  assert.ok(!(await settings.text()).includes("synthetic-api-key"));
  assert.equal(
    (
      await h.request("/api/automation/settings", "POST", {
        model: "invalid model",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.request(
        "/api/automation/settings",
        "POST",
        { key: "key", model: "valid" },
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  assert.equal((await h.request("/api/gemini-flow")).status, 200);
  assert.equal(
    (
      await h.request(
        "/api/gemini-flow",
        "POST",
        { command: "start" },
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request("/api/gemini-flow", "POST", {
        command: "input",
        id: "stale",
        token: "stale",
        value: "do-not-log",
      })
    ).status,
    400,
  );
  const result = await (
    await h.request("/api/action", "POST", {
      type: "navigate",
      url: "private search text",
    })
  ).json();
  assert.equal(result.code, "BROWSER_CLOSED");
  const exported = await h.request("/api/logs/export");
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  assert.doesNotMatch(await exported.text(), /private search text/);
  await writeAdmin(h.data, "admin", "new native revoked password", true);
  assert.equal((await h.request("/api/state")).status, 401);
  assert.equal((await h.request("/api/gemini-flow")).status, 401);
  assert.equal((await h.request("/api/automation/settings")).status, 401);
});
test("live logs and viewer require an authenticated same-origin socket and revoke on password reset", async (t) => {
  const h = await harness(t);
  await h.login();
  for (const headers of [
    { Origin: "http://evil.example", Cookie: h.cookie() },
    { Origin: h.base },
  ]) {
    const ws = new WebSocket(h.base.replace("http:", "ws:") + "/stream", {
      headers,
    });
    await new Promise((resolve, reject) => {
      ws.once("error", resolve);
      ws.once("open", () => {
        ws.close();
        reject(new Error("Unauthorized stream accepted"));
      });
    });
  }
  const ws = new WebSocket(h.base.replace("http:", "ws:") + "/stream", {
    headers: { Origin: h.base, Cookie: h.cookie() },
  });
  await new Promise((resolve, reject) => {
    ws.on("message", (data, binary) => {
      if (!binary && JSON.parse(data).type === "state") resolve();
    });
    ws.on("error", reject);
  });
  const closed = new Promise((resolve) => ws.once("close", resolve));
  await writeAdmin(h.data, "admin", "another native password reset", true);
  assert.equal(await closed, 4001);
});
test("managed downloads retain original bytes and never expose symlinks or incomplete files", async (t) => {
  const h = await harness(t);
  const b = h.service.browser;
  await fs.mkdir(b.downloadDir, { recursive: true });
  await fs.writeFile(path.join(b.downloadDir, "example.txt"), "original bytes");
  await fs.writeFile(path.join(b.downloadDir, "example.crdownload"), "partial");
  await fs.symlink(
    path.join(h.data, "admin.json"),
    path.join(b.downloadDir, "secret.txt"),
  );
  const files = await b.downloads();
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "example.txt");
  await assert.rejects(b.download("../admin.json"));
  await h.login();
  const response = await h.request(`/api/downloads/${files[0].id}`);
  assert.equal(await response.text(), "original bytes");
});
test("native network proxy pins approved destinations and refuses private HTTP/CONNECT targets", async (t) => {
  const fixture = http.createServer((req, res) => res.end("fixture"));
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => fixture.close(r)));
  const base = `http://127.0.0.1:${fixture.address().port}/`;
  const denied = await startBrowserProxy();
  t.after(() => denied.close());
  const status = await new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: denied.port, path: base }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(status, 403);
  const tunnel = await new Promise((resolve, reject) => {
    const socket = net.connect(denied.port, "127.0.0.1", () =>
      socket.write(
        "CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
      ),
    );
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.toString());
    });
    socket.on("error", reject);
  });
  assert.match(tunnel, /403/);
  const allowed = await startBrowserProxy({
    validate: async (value) => {
      assert.equal(value, base);
      return value;
    },
  });
  t.after(() => allowed.close());
  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: allowed.port, path: base }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
  assert.equal(body, "fixture");
});
test(
  "bundled Windows and macOS helper entrypoints load on their native CI hosts",
  { skip: !["win32", "darwin"].includes(process.platform) },
  async () => {
    if (process.platform === "win32")
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          fileURLToPath(new URL("../src/native/windows.ps1", import.meta.url)),
        ],
        { input: "", timeout: 30000 },
      );
    if (process.platform === "darwin") {
      const output = await run(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          fileURLToPath(new URL("../src/native/macos.js", import.meta.url)),
        ],
        { input: JSON.stringify({ type: "capture", pid: 0 }) },
      );
      assert.equal(JSON.parse(output).ok, false);
      assert.equal(JSON.parse(output).code, "WINDOW_NOT_READY");
      const diagnostic = await run(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          fileURLToPath(new URL("../src/native/macos.js", import.meta.url)),
        ],
        { input: JSON.stringify({ type: "diagnostics", pid: 0 }) },
      );
      const parsed = JSON.parse(diagnostic);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.result.windowQuery, "ok");
      for (const field of ["screenRecording", "accessibility"])
        assert.ok(
          [true, false, null].includes(parsed.result.permissions[field]),
        );
    }
  },
);
const nativeEnabled =
  process.platform === "linux" && process.env.RUN_NATIVE_TESTS === "1";
test(
  "real native Linux Chrome: OS input, original download, profile reuse and responsive authenticated viewer",
  { skip: !nativeEnabled, timeout: 90000 },
  async (t) => {
    const requests = [];
    let fixtureSignedIn = false;
    let providerBase = "";
    const loginInputs = [];
    const recoveryBodies = [];
    const uploads = [];
    const fixture = http.createServer((req, res) => {
      const url = new URL(req.url, "http://fixture");
      requests.push({
        path: url.pathname,
        q: url.searchParams.get("q"),
        cookie: req.headers.cookie || "",
        x: Number(url.searchParams.get("x")),
        y: Number(url.searchParams.get("y")),
      });
      if (url.pathname === "/app") {
        res.setHeader("Content-Type", "text/html");
        const html = fixtureSignedIn
          ? '<!doctype html><button aria-label="Google Account: Synthetic test">Account</button><div contenteditable="true" role="textbox">Ask Gemini</div>'
          : '<!doctype html><a role="button" href="' +
            providerBase +
            '/signin">Sign in</a>';
        // Delay commitment so observation cannot accidentally classify the preceding page.
        setTimeout(() => res.end(html), 300);
        return;
      }
      if (url.pathname === "/upload-received") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          uploads.push(Buffer.concat(chunks).toString());
          res.end("ok");
        });
        return;
      }
      if (url.pathname === "/upload-page") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><title>Native upload fixture</title><h1>Upload test</h1><input type="file" autofocus oncancel="fetch('/upload-cancel')" onchange="fetch('/upload-received',{method:'POST',body:this.files[0]})"><script>let reported=false;function ready(){if(reported||document.hidden||document.prerendering||!document.hasFocus()||document.readyState!=='complete')return;reported=true;const input=document.querySelector('input');input.focus();requestAnimationFrame(()=>{const r=input.getBoundingClientRect();fetch('/ready-file?x='+encodeURIComponent(r.x+10+screenX)+'&y='+encodeURIComponent(r.y+10+screenY+outerHeight-innerHeight));});}addEventListener('load',ready);addEventListener('focus',ready,true);document.addEventListener('visibilitychange',ready);document.addEventListener('prerenderingchange',ready);ready();</script>`,
        );
        return;
      }
      if (url.pathname === "/file") {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="original.txt"',
        });
        res.end("original native download");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.setHeader(
        "Set-Cookie",
        "native_session=preserved; Max-Age=3600; Path=/",
      );
      res.end(
        `<!doctype html><title>Native Chrome fixture</title><style>body{font:20px sans-serif;background:#eef4ff;padding:30px}input{padding:12px;font:inherit}</style><h1>Real desktop Chrome</h1><form><input name="q" autofocus oninput="fetch('/typed?q='+encodeURIComponent(this.value))"><button>Submit</button></form><a href="/file" download>Download original</a><script>let reported=false;function ready(){if(reported||document.hidden||document.prerendering||document.readyState!=="complete")return;reported=true;const input=document.querySelector("input");input.focus();requestAnimationFrame(()=>{const r=input.getBoundingClientRect();fetch("/ready?x="+encodeURIComponent(r.x+10+screenX)+"&y="+encodeURIComponent(r.y+10+screenY+outerHeight-innerHeight));});}addEventListener("load",ready);document.addEventListener("visibilitychange",ready);document.addEventListener("prerenderingchange",ready);ready();</script>`,
      );
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => fixture.close(r)));
    const base = `http://127.0.0.1:${fixture.address().port}`;
    const provider = http.createServer((req, res) => {
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          loginInputs.push({
            kind: req.url,
            value: Buffer.concat(chunks).toString(),
          });
          if (req.url === "/password") fixtureSignedIn = true;
          res.end("ok");
        });
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><script>function draw(kind){document.body.innerHTML=kind==='email'?'<input type="email" id="identifierId" name="identifier"><button>Next</button>':'<input type="password" name="Passwd"><button>Next</button>';document.querySelector('button').onclick=async()=>{await fetch('/'+kind,{method:'POST',body:document.querySelector('input').value});if(kind==='email')draw('password');else location.href=${JSON.stringify(base + "/app")};};}addEventListener('load',()=>{document.body.innerHTML='<button>Use another account</button><button>Use another account</button>';for(const b of document.querySelectorAll('button'))b.onclick=()=>draw('email');});</script>`,
      );
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    providerBase = `http://127.0.0.1:${provider.address().port}`;
    t.after(() => new Promise((r) => provider.close(r)));
    const validate = async (value) => {
      if (value.startsWith(base + "/") || value.startsWith(providerBase + "/"))
        return value;
      throw new Error("Private addresses are blocked");
    };
    const h = await harness(t, {
      chromePath: process.env.TEST_CHROME,
      homepage: base + "/",
      validateUrl: validate,
      proxyOptions: { validate },
      groqOptions: {
        env: {},
        fetchImpl: async (url, options) => {
          recoveryBodies.push(options.body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      operation: "click",
                      candidateId: "c0",
                    }),
                  },
                },
              ],
              usage: { total_tokens: 10 },
            }),
          );
        },
      },
    });
    const b = h.service.browser;
    await b.start();
    try {
      await eventually(() => requests.some((r) => r.path === "/ready"));
      const capture = await b.capture();
      assert.equal(jpegDimensions(capture).width, 1280);
      const ready = requests.find((r) => r.path === "/ready");
      let typed = false;
      for (let attempt = 0; attempt < 3 && !typed; attempt++) {
        await b.action({ type: "click", x: ready.x, y: ready.y });
        await b.action({ type: "key", key: "Control+A" });
        await b.action({ type: "text", text: "native input checked" });
        try {
          await eventually(
            () =>
              requests.some(
                (r) => r.path === "/typed" && r.q === "native input checked",
              ),
            2500,
          );
          typed = true;
        } catch {
          /* A native activation click can be consumed. Retype only in this fixture. */
        }
      }
      assert.equal(
        typed,
        true,
        "Native input never reached the fixture textbox",
      );
      await b.action({ type: "key", key: "Enter" });
      await eventually(() =>
        requests.some((r) => r.path === "/" && r.q === "native input checked"),
      );
      await b.action({ type: "navigate", url: base + "/file" });
      try {
        await eventually(async () => (await b.downloads()).length > 0);
      } catch (error) {
        await fs.mkdir("test-results", { recursive: true });
        await fs.writeFile(
          "test-results/native-failure.jpg",
          await b.capture(),
        );
        console.log("Synthetic fixture requests", requests);
        console.log(
          "Synthetic download files",
          await fs.readdir(b.downloadDir),
        );
        throw error;
      }
      const file = (await b.downloads())[0];
      assert.equal(
        await fs.readFile((await b.download(file.id)).path, "utf8"),
        "original native download",
      );
      await b.action({ type: "navigate", url: base + "/upload-page" });
      await eventually(() => requests.some((r) => r.path === "/ready-file"));
      const fileButton = requests.find((r) => r.path === "/ready-file");
      for (let attempt = 0; attempt < 3 && !uploads.length; attempt++) {
        const cancellations = requests.filter(
          (r) => r.path === "/upload-cancel",
        ).length;
        await b.action({ type: "click", x: fileButton.x, y: fileButton.y });
        try {
          await eventually(() => b.driver.fileDialog(), 2500);
        } catch {
          // A window-manager activation click can be consumed when the tab first receives focus.
          await b.action({ type: "click", x: fileButton.x, y: fileButton.y });
          await eventually(() => b.driver.fileDialog());
        }
        await b.upload({
          originalname: "reference.txt",
          buffer: Buffer.from("original native upload"),
          mimetype: "text/plain",
        });
        await eventually(
          () =>
            uploads.length > 0 ||
            requests.filter((r) => r.path === "/upload-cancel").length >
              cancellations,
        );
        if (!uploads.length) assert.equal(await b.driver.fileDialog(), false);
      }
      try {
        await eventually(() => uploads.includes("original native upload"));
      } catch (error) {
        await fs.mkdir("test-results", { recursive: true });
        await fs.writeFile(
          "test-results/native-upload-failure.jpg",
          await b.capture(),
        );
        console.log(
          "Synthetic upload observations",
          requests,
          uploads,
          b.testStderr,
        );
        throw error;
      }
      const other = new RemoteBrowser(h.config, {
        test: true,
        chromePath: process.env.TEST_CHROME,
      });
      await assert.rejects(
        other.start(),
        (e) => e.code === "BROWSER_PROFILE_BUSY",
      );
      await other.stop();
      assert.equal(
        JSON.parse(await fs.readFile(path.join(b.data, "browser.json"), "utf8"))
          .pid,
        b.child.pid,
      );
      await b.stop();
      const before = requests.length;
      await b.start();
      await eventually(() =>
        requests
          .slice(before)
          .some((r) => r.cookie.includes("native_session=preserved")),
      );
      const managedPid = b.child.pid;
      const originalValidate = b.options.validateUrl;
      const originalCommand = b.driver.command;
      b.options.validateUrl = async (value) =>
        value === "https://accounts.google.com/AccountChooser"
          ? base + "/google-signin-fixture"
          : originalValidate(value);
      b.driver.command = async () => {
        throw new Error("Native keyboard permission unavailable in this test");
      };
      try {
        await b.action({ type: "googleSignIn" });
        await eventually(() =>
          requests.some((r) => r.path === "/google-signin-fixture"),
        );
        assert.equal(b.child.pid, managedPid);
        assert.ok(b.running);
      } finally {
        b.options.validateUrl = originalValidate;
        b.driver.command = originalCommand;
      }
      const client = await chromium.launch({
        headless: true,
        executablePath: process.env.TEST_CHROME,
        args: ["--no-sandbox"],
      });
      t.after(() => client.close());
      const page = await client.newPage({
        viewport: { width: 1400, height: 1100 },
      });
      await page.goto(h.base);
      await page.locator("#username").fill("admin");
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: "Sign in →" }).click();
      assert.equal(await page.locator("#screen").count(), 0);
      await page
        .getByRole("button", { name: "Debug console", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#debug-output")
          .textContent.includes("BROWSER_STARTED"),
      );
      b.options.validateUrl = async (value) =>
        value === GEMINI_URL
          ? base + "/app"
          : value === GOOGLE_LOGIN
            ? providerBase + "/signin"
            : originalValidate(value);
      b.options.automationOrigins = { gemini: base, google: providerBase };
      await page.locator("#groq-settings > summary").click();
      await page.locator("#groq-key").fill("synthetic-groq-key");
      await page.locator("#groq-model").fill("mock-model");
      await page.locator("#groq-save").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#groq-status")
          .textContent.startsWith("Groq configured"),
      );
      assert.equal(await page.locator("#groq-key").inputValue(), "");
      await page.locator("#gemini-start").click();
      await eventually(
        () => h.service.flow.snapshot().state === "awaiting_user",
      );
      assert.equal(await page.locator("#signin-dialog").count(), 0);
      assert.equal(loginInputs.length, 0);
      assert.equal(recoveryBodies.length, 0);
      // Simulate the user completing login externally, then verify Gemini UI.
      fixtureSignedIn = true;
      await b.gemini.open("gemini");
      await page.locator("#gemini-proceed").click();
      await eventually(() => h.service.flow.snapshot().state === "signed_in");
      assert.ok(b.child.spawnargs.includes("about:blank"));
      const targetId = b.gemini.target;
      const automationPid = b.child.pid,
        count = loginInputs.length;
      await page.locator("#gemini-start").click();
      await eventually(
        () => h.service.flow.snapshot().state === "already_signed_in",
      );
      assert.equal(loginInputs.length, count);
      assert.equal(b.child.pid, automationPid);
      assert.equal(b.gemini.target, targetId);
      assert.equal(recoveryBodies.length, 0);
      assert.equal((await b.state()).backgroundInput, true);
      await fs.mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/native-desktop.png",
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
        path: "test-results/native-mobile.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.locator("#login-panel").waitFor({ state: "visible" });
      await eventually(() => !b.running);
    } catch (error) {
      if (b.running) {
        await fs.mkdir("test-results", { recursive: true });
        await fs.writeFile(
          "test-results/native-failure.jpg",
          await b.capture().catch(() => Buffer.alloc(0)),
        );
      }
      throw error;
    }
  },
);

test("native startup diagnosis identifies sandbox failures without returning raw private launch output", () => {
  const error = launchFailure(
    "No usable sandbox! /private/profile?secret=hidden",
  );
  assert.equal(error.code, "BROWSER_SANDBOX");
  assert.doesNotMatch(error.message, /secret=hidden|private\/profile/);
});
test("exact Host, trusted TLS transport and Secure cookies protect native controls", async (t) => {
  const h = await harness(t);
  h.config.origin = "https://native.example";
  h.config.secure = true;
  async function raw(headers) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        h.base + "/api/session",
        { headers },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response));
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
  assert.equal(
    (await raw({ Host: "evil.example", "X-Forwarded-Proto": "https" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await raw({ Host: "native.example", "X-Forwarded-Proto": "http" }))
      .statusCode,
    403,
  );
  const response = await raw({
    Host: "native.example",
    "X-Forwarded-Proto": "https",
  });
  assert.equal(response.statusCode, 200);
  // A separate secure instance is needed to test cookie attributes configured at startup.
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "native-tls-"));
  const config = {
    ...configuration({
      DATA_DIR: data,
      PUBLIC_ORIGIN: "https://native.example",
      AUTH_REQUIRED: "true",
    }),
    port: 0,
  };
  const service = await startServer(config, { test: true });
  t.after(async () => {
    await service.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  const cookie = await new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${service.port}/api/session`,
      { headers: { Host: "native.example", "X-Forwarded-Proto": "https" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["set-cookie"]?.[0]));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /HttpOnly/);
});
