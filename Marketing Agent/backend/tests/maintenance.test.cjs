const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { isOnline } = require("../services/availability");

test("ONLINE defaults online, accepts lowercase and fails closed for false or invalid settings", () => {
  for (const env of [
    {},
    { ONLINE: "true" },
    { online: "true" },
    { ONLINE: " TRUE " },
  ])
    assert.equal(isOnline(env), true);
  for (const value of ["false", "FALSE", " false ", "", "0", "yes", "invalid"])
    assert.equal(isOnline({ ONLINE: value }), false);
  assert.equal(isOnline({ online: "false" }), false);
  assert.equal(isOnline({ ONLINE: "true", online: "false" }), false);
  assert.equal(isOnline({ ONLINE: "false", online: "true" }), false);
});

test(
  "maintenance blocks every page, asset, API, method and cookie before parsing/authentication",
  { timeout: 15000 },
  async (t) => {
    const previous = process.env.ONLINE;
    process.env.ONLINE = "false";
    const app = require("../app");
    const server = await new Promise((resolve) => {
      const service = app.listen(0, "127.0.0.1", () => resolve(service));
    });
    t.after(async () => {
      if (previous === undefined) delete process.env.ONLINE;
      else process.env.ONLINE = previous;
      await new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const resource of [
      "/",
      "/ai-agent.html",
      "/login.html",
      "/js/app.js",
      "/css/styles.css",
      "/.env",
      "/does-not-exist",
    ]) {
      const response = await fetch(origin + resource, {
        headers: {
          Cookie: "token=existing-session",
          Accept: "text/html",
          "X-Online": "true",
        },
      });
      assert.equal(response.status, 503);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.match(await response.text(), /Under maintenance/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "60");
    }
    for (const [method, resource] of [
      ["GET", "/api"],
      ["GET", "/API/products"],
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/signup"],
      ["POST", "/api/promotions?ONLINE=true"],
      ["GET", "/api/promotions/id/images/1"],
      ["DELETE", "/api/products/id"],
      ["PATCH", "/api/account"],
      ["OPTIONS", "/api/products"],
    ]) {
      const response = await fetch(origin + resource, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: "token=existing-session",
        },
        ...(["POST", "PATCH"].includes(method)
          ? { body: "malformed JSON should never reach body parser" }
          : {}),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "MAINTENANCE");
    }
    const head = await fetch(origin + "/ai-agent.html", { method: "HEAD" });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), "");
    process.env.ONLINE = "true";
    assert.equal((await fetch(origin + "/login.html")).status, 200);
    assert.equal((await fetch(origin + "/api/products")).status, 401);
  },
);

test(
  "offline server starts without MongoDB or JWT and exits gracefully",
  { timeout: 15000 },
  async (t) => {
    const reserve = net.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        ONLINE: "false",
        JWT_SECRET: "",
        MONGODB_URI: "invalid-database-must-not-be-used",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    });
    let logs = "";
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Maintenance server did not start")),
        10000,
      );
      child.stdout.on("data", (chunk) => {
        logs += chunk;
        if (logs.includes("maintenance mode")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Maintenance server exited before listening"));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "MAINTENANCE");
    assert.doesNotMatch(logs, /Connected to MongoDB/);
    child.kill("SIGTERM");
    const exit = await exited;
    assert.ok(exit.code === 0 || exit.signal === "SIGTERM");
  },
);

test("image API diagnostic does not contact external services in maintenance", async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, ["scripts/check-image-api.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ONLINE: "false", IMAGE_API_BASE_URL: "not-a-url" },
      timeout: 5000,
    }),
    (error) =>
      error.code === 1 &&
      /MAINTENANCE:/.test(error.stderr) &&
      !/PROMOTION_CONFIG/.test(error.stderr),
  );
});
