const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { config } = require("../services/promotionConfig");
const { clients } = require("../services/promotionClients");
const { worker } = require("../services/promotionWorker");
const Run = require("../models/PromotionRun");

test("promotion configuration validates required secrets, trusted base URLs and budgets", () => {
  const env = {
    GROQ_API_KEY: "groq-test",
    IMAGE_API_KEY: "image-test",
    IMAGE_API_BASE_URL: "http://127.0.0.1:1234/api/v1",
  };
  assert.equal(config(env).pollMs, 3000);
  for (const changed of [
    { GROQ_API_KEY: "" },
    { IMAGE_API_KEY: "" },
    { IMAGE_API_BASE_URL: "http://public.example/api/v1" },
    { IMAGE_API_BASE_URL: "https://user:pass@example.test" },
    { GROQ_BASE_URL: "https://example.test?key=secret" },
    { PROMOTION_POLL_MS: "0" },
    { PROMOTION_MAX_IMAGE_BYTES: "999999999" },
  ])
    assert.throws(() => config({ ...env, ...changed }), {
      code: "PROMOTION_CONFIG",
    });
});

test(
  "promotion workflow: actual HTTP clients, Mongo GridFS, four sequential images, restart and browser",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120000 },
  async (t) => {
    let appServer, upstream, browser;
    const workers = [];
    await mongoose.connect(process.env.TEST_MONGODB_URI, {
      dbName: "ma_promotions_" + randomUUID().replaceAll("-", ""),
      serverSelectionTimeoutMS: 10000,
    });
    t.after(async () => {
      await browser?.close();
      for (const w of workers) await w.stop();
      if (appServer) await new Promise((r) => appServer.close(r));
      if (upstream) await new Promise((r) => upstream.close(r));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const { png } = await import("../../../tests/fixtures/png.js");
    const bytes = png(150),
      ref = "data:image/png;base64," + png(90).toString("base64"),
      logo = "data:image/png;base64," + png(40).toString("base64");
    const jobs = new Map(),
      byKey = new Map();
    let partialCounter = 0;
    let mode = "normal",
      promptCalls = 0,
      submitCalls = 0,
      startCalls = 0,
      activeRemote = 0,
      maxActiveRemote = 0;
    const referencesReceived = [];
    const errors = [];
    upstream = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        res.setHeader("Content-Type", "application/json");
        const send = (value, status = 200) => {
          res.statusCode = status;
          res.end(JSON.stringify(value));
        };
        if (req.url === "/groq/chat/completions") {
          assert.equal(req.headers.authorization, "Bearer test-groq-only");
          const data = JSON.parse(body.toString());
          assert.equal(data.response_format.type, "json_object");
          assert.equal(
            data.messages[1].content.includes("test-image-only"),
            false,
          );
          promptCalls++;
          if (mode === "groq-timeout") {
            await new Promise((r) => setTimeout(r, 150));
            send({});
            return;
          }
          if (mode === "groq-error") {
            send({ choices: [{ message: { content: "not JSON" } }] });
            return;
          }
          send({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: `Create promotional concept ${promptCalls}, preserve reference product and business logo.`,
                  }),
                },
              },
            ],
          });
          return;
        }
        assert.equal(req.headers.authorization, "Bearer test-image-only");
        if (req.url === "/api/v1/browser/start") {
          startCalls++;
          send({ running: true });
          return;
        }
        if (req.url === "/api/v1/generations" && req.method === "POST") {
          const form = await new Request("http://fixture.test", {
            method: "POST",
            headers: { "Content-Type": req.headers["content-type"] },
            body,
          }).formData();
          const key = req.headers["idempotency-key"];
          assert.match(key, /^promotion-[a-f0-9]{24}-[1-4]$/);
          assert.match(form.get("prompt"), /promotional concept|resume prompt/);
          const files = form.getAll("references");
          referencesReceived.push(
            await Promise.all(
              files.map(async (f) =>
                Buffer.from(await f.arrayBuffer()).toString("base64"),
              ),
            ),
          );
          assert.equal(files.length, 2);
          if (byKey.has(key)) {
            send(jobs.get(byKey.get(key)));
            return;
          }
          const id = randomUUID();
          const job = {
            id,
            state: "queued",
            polls: 0,
            mode:
              mode === "partial"
                ? ++partialCounter === 1
                  ? "normal"
                  : "bad-image"
                : mode,
            done: false,
          };
          byKey.set(key, id);
          jobs.set(id, job);
          submitCalls++;
          activeRemote++;
          maxActiveRemote = Math.max(maxActiveRemote, activeRemote);
          send(job, 202);
          return;
        }
        const match = /^\/api\/v1\/generations\/([\w-]+)(\/image)?$/.exec(
          req.url,
        );
        if (match) {
          const job = jobs.get(match[1]);
          if (!job) {
            send({}, 404);
            return;
          }
          if (match[2]) {
            res.setHeader("Content-Type", "image/png");
            res.end(
              job.mode === "bad-image" ? Buffer.from("not an image") : bytes,
            );
            return;
          }
          job.polls++;
          job.state =
            job.mode === "login"
              ? "needs_login"
              : job.mode === "no-image"
                ? "failed"
                : job.mode === "hold"
                  ? "generating"
                  : job.polls > 1
                    ? "completed"
                    : "generating";
          if (
            ["completed", "failed", "needs_login"].includes(job.state) &&
            !job.done
          ) {
            job.done = true;
            activeRemote--;
          }
          send({
            id: job.id,
            state: job.state,
            chatId: "chat123",
            chatUrl: "https://gemini.google.com/app/chat123",
          });
          return;
        }
        send({}, 404);
      } catch (error) {
        errors.push(error);
        res.statusCode = 500;
        res.end("{}");
      }
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    Object.assign(process.env, {
      JWT_SECRET: randomBytes(32).toString("hex"),
      GROQ_API_KEY: "test-groq-only",
      GROQ_BASE_URL: origin + "/groq",
      IMAGE_API_KEY: "test-image-only",
      IMAGE_API_BASE_URL: origin + "/api/v1",
    });
    const c = () => ({ ...config(), pollMs: 5 });
    const makeWorker = () => {
      const w = worker({ getConfig: c });
      workers.push(w);
      return w;
    };
    const w1 = makeWorker(),
      w2 = makeWorker();
    const app = require("../app");
    appServer = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const base = `http://127.0.0.1:${appServer.address().port}`;
    const User = require("../models/User"),
      Profile = require("../models/Profile"),
      Product = require("../models/Product");
    const owner = await User.create({
      name: "Tea Owner",
      email: "owner@example.test",
      role: "owner",
      passwordHash: "test-only",
    });
    const other = await User.create({
      name: "Other",
      email: "other@example.test",
      role: "owner",
      passwordHash: "test-only",
    });
    const customer = await User.create({
      name: "Customer",
      email: "customer@example.test",
      role: "customer",
      passwordHash: "test-only",
    });
    await Profile.create({
      owner: owner._id,
      name: "Ceylon Tea Studio",
      description: "Locally sourced tea for everyday enjoyment.",
      logo,
    });
    const product = await Product.create({
      owner: owner._id,
      name: "Green Tea",
      description: "Loose leaf tea",
      image: ref,
    });
    await Run.init();
    const token = (u) =>
      jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
    const request = (
      path,
      method = "GET",
      body,
      user = owner,
      key = randomUUID(),
    ) =>
      fetch(base + "/api" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          ...(user ? { Cookie: "token=" + token(user) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const create = async () => {
      const response = await request("/promotions", "POST", {
        targetType: "product",
        productId: String(product._id),
      });
      assert.equal(response.status, 202);
      return (await response.json()).promotion;
    };
    await t.test(
      "authorization, config errors, ownership, idempotency, four images and exact references",
      async () => {
        assert.equal(
          (await request("/promotions", "GET", null, null)).status,
          401,
        );
        assert.equal(
          (await request("/promotions", "GET", null, customer)).status,
          403,
        );
        const savedKey = process.env.GROQ_API_KEY;
        delete process.env.GROQ_API_KEY;
        assert.equal(
          (await request("/promotions", "POST", { targetType: "business" }))
            .status,
          503,
        );
        process.env.GROQ_API_KEY = savedKey;
        await Profile.create({
          owner: other._id,
          name: "Other business",
          description: "A completely separate business for isolation.",
        });
        assert.equal(
          (
            await request(
              "/promotions",
              "POST",
              { targetType: "product", productId: String(product._id) },
              other,
            )
          ).status,
          404,
        );
        const key = randomUUID(),
          body = { targetType: "product", productId: String(product._id) };
        const [a, b] = await Promise.all([
          request("/promotions", "POST", body, owner, key),
          request("/promotions", "POST", body, owner, key),
        ]);
        const run = (await a.json()).promotion;
        assert.equal((await b.json()).promotion.id, run.id);
        assert.equal(
          (
            await request(
              "/promotions",
              "POST",
              { targetType: "business" },
              owner,
              key,
            )
          ).status,
          409,
        );
        await Promise.all([w1.tick(), w2.tick()]);
        const result = (await (await request("/promotions/" + run.id)).json())
          .promotion;
        assert.equal(result.state, "completed");
        assert.equal(result.completed, 4);
        assert.equal(submitCalls, 4);
        assert.equal(promptCalls, 4);
        assert.equal(startCalls, 1);
        assert.equal(maxActiveRemote, 1);
        assert.equal(new Set(result.items.map((i) => i.prompt)).size, 4);
        assert.equal(
          (await request("/promotions/" + run.id, "GET", null, other)).status,
          404,
        );
        assert.equal(
          (
            await request(
              result.items[0].imageUrl.replace("/api", ""),
              "GET",
              null,
              other,
            )
          ).status,
          404,
        );
        const downloaded = await request(
          result.items[0].imageUrl.replace("/api", ""),
        );
        assert.equal(downloaded.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
        for (const refs of referencesReceived)
          assert.deepEqual(refs, [ref.split(",")[1], logo.split(",")[1]]);
        assert.equal(result.items[0].width, 64);
        assert.equal(result.items[0].chatId, "chat123");
        assert.equal(
          await mongoose.connection.db
            .collection("promotionImages.files")
            .countDocuments(),
          4,
        );
        assert.equal(JSON.stringify(result).includes("data:image"), false);
        assert.equal(JSON.stringify(result).includes("test-image-only"), false);
      },
    );
    await t.test(
      "Promote triggers generation from the browser and renders saved images responsively",
      async () => {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.TEST_CHROME || undefined,
          args: ["--no-sandbox"],
        });
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        await page.context().addCookies([
          {
            name: "token",
            value: token(owner),
            url: base,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        await page.goto(base + "/ai-agent.html");
        const response = page.waitForResponse(
          (r) =>
            r.url() === base + "/api/promotions" &&
            r.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Promote Green Tea", exact: true })
          .click();
        const run = (await (await response).json()).promotion;
        assert.equal(run.state, "queued");
        await w1.tick();
        await page
          .getByRole("button", { name: "Refresh promotions", exact: true })
          .click();
        await page
          .locator(`[data-promotion-id="${run.id}"]`)
          .getByText("4 / 4 images saved · completed", { exact: true })
          .waitFor();
        await page
          .locator(".promotion-image img")
          .evaluateAll((images) =>
            images.forEach((image) => (image.loading = "eager")),
          );
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".promotion-image img")]
            .filter((img) => !img.hidden)
            .every((img) => img.complete && img.naturalWidth > 0),
        );
        assert.equal(
          await page
            .getByRole("link", { name: "Download original", exact: true })
            .count(),
          8,
        );
        const firstRow = await page
          .locator(`[data-promotion-id="${run.id}"] .promotion-image`)
          .evaluateAll((nodes) =>
            nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
          );
        assert.equal(
          new Set(firstRow).size,
          1,
          "four result cards fit the desktop row",
        );
        const fs = require("node:fs/promises");
        await fs.mkdir("test-results", { recursive: true });
        await page
          .locator("#promotionResults")
          .evaluate((node) =>
            node.scrollIntoView({ behavior: "instant", block: "start" }),
          );
        await page.screenshot({
          path: "test-results/promotion-generation-desktop.png",
          fullPage: false,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page
          .locator("#promotionResults")
          .evaluate((node) =>
            node.scrollIntoView({ behavior: "instant", block: "start" }),
          );
        await page.screenshot({
          path: "test-results/promotion-generation-mobile.png",
          fullPage: false,
        });
        await browser.close();
        browser = null;
      },
    );
    await t.test(
      "manual login, missing image, invalid Groq and corrupt downloads stop without resubmission",
      async () => {
        for (const [scenario, expected] of [
          ["login", "GENERATION_LOGIN_REQUIRED"],
          ["no-image", "GENERATION_FAILED"],
          ["groq-error", "GROQ_PROMPT"],
          ["bad-image", "IMAGE_INVALID"],
        ]) {
          mode = scenario;
          const before = submitCalls,
            run = await create();
          await w1.tick();
          const result = await Run.findById(run.id);
          assert.equal(result.error.code, expected);
          assert.equal(result.current, 0);
          assert.equal(submitCalls - before, scenario === "groq-error" ? 0 : 1);
        }
        mode = "normal";
      },
    );
    await t.test(
      "partial failures preserve completed image bytes and stop at the failed variation",
      async () => {
        mode = "partial";
        partialCounter = 0;
        const run = await create(),
          before = submitCalls;
        await w1.tick();
        const result = (await (await request("/promotions/" + run.id)).json())
          .promotion;
        assert.equal(result.state, "needs_review");
        assert.equal(result.completed, 1);
        assert.equal(result.error.code, "IMAGE_INVALID");
        assert.equal(submitCalls - before, 2);
        assert.deepEqual(
          Buffer.from(
            await (
              await request(result.items[0].imageUrl.replace("/api", ""))
            ).arrayBuffer(),
          ),
          bytes,
        );
        mode = "normal";
      },
    );
    await t.test(
      "expired deadlines and changed provider credentials stop before new remote requests",
      async () => {
        const run = await create(),
          before = submitCalls;
        await Run.updateOne(
          { _id: run.id },
          { $set: { deadline: new Date(0) } },
        );
        await w1.tick();
        assert.equal(
          (await Run.findById(run.id)).error.code,
          "PROMOTION_TIMEOUT",
        );
        const changed = await create(),
          old = process.env.IMAGE_API_KEY;
        process.env.IMAGE_API_KEY = "changed-token";
        await w1.tick();
        process.env.IMAGE_API_KEY = old;
        assert.equal(
          (await Run.findById(changed.id)).error.code,
          "PROMOTION_CONFIG",
        );
        assert.equal(submitCalls, before);
      },
    );
    await t.test(
      "an expired worker lease resumes a saved remote job without another prompt submission",
      async () => {
        const run = await create(),
          before = submitCalls,
          beforePrompts = promptCalls;
        const api = clients(c());
        const job = await api.submit(
          "resume prompt",
          [ref, logo],
          `promotion-${run.id}-1`,
        );
        await Run.updateOne(
          { _id: run.id },
          {
            $set: {
              state: "generating",
              "items.0.prompt": "resume prompt",
              "items.0.remoteJobId": job.id,
            },
          },
        );
        await mongoose.connection.db.collection("promotionLeases").insertOne({
          _id: "global",
          holder: "dead-worker",
          expires: new Date(Date.now() + 60000),
        });
        await w2.tick();
        assert.equal((await Run.findById(run.id)).current, 0);
        await mongoose.connection.db
          .collection("promotionLeases")
          .updateOne({ _id: "global" }, { $set: { expires: new Date(0) } });
        await w2.tick();
        const done = await Run.findById(run.id);
        assert.equal(done.state, "completed");
        assert.equal(submitCalls - before, 4);
        assert.equal(promptCalls - beforePrompts, 3);
        assert.equal(done.items[0].remoteJobId, job.id);
      },
    );
    await t.test(
      "restart between submission and saving the remote ID reuses its idempotency key",
      async () => {
        const run = await create(),
          before = submitCalls;
        const job = await clients(c()).submit(
          "resume prompt",
          [ref, logo],
          `promotion-${run.id}-1`,
        );
        await Run.updateOne(
          { _id: run.id },
          { $set: { state: "submitting", "items.0.prompt": "resume prompt" } },
        );
        await w1.tick();
        const done = await Run.findById(run.id);
        assert.equal(done.state, "completed");
        assert.equal(submitCalls - before, 4);
        assert.equal(done.items[0].remoteJobId, job.id);
      },
    );
    await t.test(
      "cancelled queued jobs do not submit, and Groq timeout is bounded and sanitized",
      async () => {
        const run = await create(),
          before = submitCalls;
        assert.equal(
          (await request(`/promotions/${run.id}/cancel`, "POST", {}, other))
            .status,
          404,
        );
        await request(`/promotions/${run.id}/cancel`, "POST", {});
        await w1.tick();
        assert.equal(submitCalls, before);
        assert.equal((await Run.findById(run.id)).state, "cancelled");
        mode = "groq-timeout";
        await assert.rejects(
          clients({ ...c(), requestMs: 20 }).prompt({}, 0, []),
          (e) =>
            e.code === "UPSTREAM_UNAVAILABLE" &&
            !e.message.includes("test-groq-only"),
        );
        mode = "normal";
      },
    );
    await t.test(
      "maintenance preserves queued work and makes no remote calls until online",
      async () => {
        const run = await create(),
          before = submitCalls,
          previous = process.env.ONLINE;
        try {
          process.env.ONLINE = "false";
          await Promise.all([w1.tick(), w2.tick()]);
          assert.equal(submitCalls, before);
          assert.equal((await Run.findById(run.id)).state, "queued");
          assert.equal(
            await mongoose.connection.db
              .collection("promotionLeases")
              .countDocuments(),
            0,
          );
          assert.equal(
            (await request("/promotions", "POST", { targetType: "business" }))
              .status,
            503,
          );
        } finally {
          if (previous === undefined) delete process.env.ONLINE;
          else process.env.ONLINE = previous;
        }
        await w1.tick();
        assert.equal((await Run.findById(run.id)).state, "completed");
        assert.equal(submitCalls - before, 4);
      },
    );
    assert.deepEqual(errors, []);
  },
);
