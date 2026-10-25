import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import session from "express-session";
import argon2 from "argon2";
import sharp from "sharp";
import {
  connect,
  AdminUser,
  GoogleAccount,
  GeminiChat,
  GenerationJob,
  Asset,
  GeneratedOutput,
} from "../../src/models/index.js";
import { createApp } from "../../src/app.js";
import {
  LockManager,
  claim,
  recover,
  enqueue,
} from "../../src/services/jobQueue.js";
import { storeAsset } from "../../src/services/assetUploader.js";
import { saveOutput } from "../../src/services/outputManager.js";
import { storage } from "../../src/utils/files.js";
let mongo, config, app, csrf, cookie;
const origin = "https://localhost:3443";
async function call(method, url, body, token = csrf, auth = true) {
  let r = request(app)
    [method](url)
    .set("Host", "localhost:3443")
    .set("X-Forwarded-Proto", "https")
    .set("Origin", origin);
  if (token) r = r.set("x-csrf-token", token);
  if (auth && cookie) r = r.set("Cookie", cookie);
  if (body) r = r.send(body);
  return r;
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  config = {
    MONGODB_URI: mongo.getUri(),
    SESSION_SECRET: "x".repeat(40),
    PUBLIC_ORIGIN: origin,
    DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "gemini-tests-")),
    GROQ_API_KEY: "",
    GROQ_MODEL: "test",
  };
  await storage(config);
  await connect(config.MONGODB_URI);
  app = createApp(config, {}, { store: new session.MemoryStore() }).app;
  await AdminUser.create({
    username: "admin",
    passwordHash: await argon2.hash("longpassword123456"),
  });
  const me = await call("get", "/api/auth/me", null, null, false);
  cookie = me.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  csrf = me.body.csrf;
  const login = await call("post", "/api/auth/login", {
    username: "admin",
    password: "longpassword123456",
  });
  assert.equal(login.status, 200);
  csrf = login.body.csrf;
  cookie = login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (config) await fs.rm(config.DATA_DIR, { recursive: true, force: true });
});
test("auth secure cookies, CSRF, plaintext and unauthorized routes", async () => {
  const health = await call("get", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(
    (await call("get", "/api/accounts", null, null, false)).status,
    401,
  );
  assert.equal(
    (await call("post", "/api/accounts", { email: "a@example.com" }, "wrong"))
      .status,
    403,
  );
  assert.equal(
    (await request(app).get("/api/health").set("Host", "localhost:3443"))
      .status,
    426,
  );
  assert.equal(
    (
      await call("post", "/api/auth/login", {
        username: "admin",
        password: "bad",
      })
    ).status,
    401,
  );
});
test("single administrator unique identity", async () => {
  await assert.rejects(
    () => AdminUser.create({ username: "second", passwordHash: "hash" }),
    { code: 11000 },
  );
});
test("account CRUD and cross-account chat isolation", async () => {
  const a = await call("post", "/api/accounts", { email: "a@example.com" });
  const b = await call("post", "/api/accounts", { email: "b@example.com" });
  assert.equal(a.status, 201);
  const c = await call("post", "/api/chats", {
    accountId: a.body._id,
    title: "A chat",
  });
  const response = await call("post", "/api/generate", {
    accountId: b.body._id,
    chatId: c.body._id,
    createNew: false,
    prompt: "test",
    assetIds: [],
  });
  assert.equal(response.status, 400);
  const bad = await request(app)
    .post("/api/generate")
    .set("Host", "localhost:3443")
    .set("X-Forwarded-Proto", "https")
    .set("Origin", origin)
    .set("Cookie", cookie)
    .set("x-csrf-token", csrf)
    .set("idempotency-key", "crossaccount123")
    .send({
      accountId: b.body._id,
      chatId: c.body._id,
      createNew: false,
      prompt: "test",
      assetIds: [],
    });
  assert.equal(bad.body.error.code, "CHAT_ACCOUNT");
  assert.equal(
    (await call("delete", `/api/accounts/${a.body._id}`, {})).status,
    400,
  );
  assert.equal(
    (await call("get", "/api/accounts?limit=1")).body.items.length,
    1,
  );
});
test("atomic FIFO, idempotency conflicts, multiple worker startup, profile isolation", async () => {
  await GenerationJob.deleteMany({});
  const a = await GoogleAccount.findOne();
  const dto = {
    accountId: String(a._id),
    createNew: true,
    prompt: "first",
    assetIds: [],
  };
  const duplicates = await Promise.all(
    Array.from({ length: 6 }, () => enqueue(dto, "same-request-key")),
  );
  assert.equal(new Set(duplicates.map((j) => String(j._id))).size, 1);
  await assert.rejects(
    () => enqueue({ ...dto, prompt: "different" }, "same-request-key"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  const second = await enqueue(
    { ...dto, prompt: "second" },
    "second-request-key",
  );
  const locks = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const l = new LockManager();
      return { l, result: await l.acquire("worker") };
    }),
  );
  assert.equal(locks.filter((x) => x.result).length, 1);
  const owner = locks.find((x) => x.result).l;
  const j = await claim(owner);
  assert.equal(j.prompt, "first");
  assert.equal(String((await claim(owner))._id), String(second._id));
  await owner.release("worker");
  const l1 = new LockManager(),
    l2 = new LockManager();
  assert(await l1.acquire("profile:a"));
  assert.equal(await l2.acquire("profile:a"), null);
  assert(await l2.acquire("profile:b"));
  await l1.release("profile:a");
  await l2.release("profile:b");
});
test("crash recovery never resubmits ambiguous prompts", async () => {
  const jobs = await GenerationJob.find().sort({ createdAt: 1 });
  await GenerationJob.findByIdAndUpdate(jobs[0]._id, {
    state: "submitting_prompt",
    submissionStartedAt: new Date(),
  });
  await recover();
  assert.equal(
    (await GenerationJob.findById(jobs[0]._id)).state,
    "needs_review",
  );
  assert.equal((await GenerationJob.findById(jobs[1]._id)).state, "queued");
});
test("upload sniffing and actual output metadata, protected downloads", async () => {
  await assert.rejects(
    () =>
      storeAsset(
        {
          buffer: Buffer.from('<svg onload="steal()"/>'),
          originalname: "a.png",
          size: 20,
        },
        config,
      ),
    { code: "UPLOAD_TYPE" },
  );
  const buf = await sharp({
    create: { width: 13, height: 17, channels: 3, background: "#88ff00" },
  })
    .png()
    .toBuffer();
  const asset = await storeAsset(
    { buffer: buf, originalname: "../../logo.png", size: buf.length },
    config,
  );
  assert.equal(asset.originalName, "logo.png");
  const a = await GoogleAccount.findOne();
  const j = await GenerationJob.findOne();
  const out = await saveOutput(
    buf,
    { ...j.toObject(), accountId: a._id },
    [asset],
    config,
  );
  assert.equal(out.width, 13);
  assert.equal(out.height, 17);
  assert.equal(out.bytes, buf.length);
  assert.equal(out.metadata.inputAssets[0], "logo.png");
  assert.equal(
    (await call("get", `/api/outputs/${out._id}/image`)).status,
    200,
  );
  assert.equal(
    (await call("get", `/api/outputs/${out._id}/image`, null, null, false))
      .status,
    401,
  );
  assert.equal(
    (await call("delete", `/api/outputs/${out._id}`, { confirm: true })).status,
    200,
  );
  assert.equal(await GeneratedOutput.countDocuments(), 0);
});
test("cancel queued job and bounded retry", async () => {
  const a = await GoogleAccount.findOne();
  const j = await enqueue(
    {
      accountId: String(a._id),
      createNew: true,
      prompt: "cancel",
      assetIds: [],
    },
    "cancel-request-key",
  );
  assert.equal(
    (await call("post", `/api/jobs/${j._id}/cancel`)).body.state,
    "cancelled",
  );
  assert.equal(
    (await call("post", `/api/jobs/${j._id}/retry`, {})).body.state,
    "queued",
  );
  await GenerationJob.findByIdAndUpdate(j._id, {
    state: "needs_review",
    submissionStartedAt: new Date(),
  });
  assert.equal(
    (await call("post", `/api/jobs/${j._id}/retry`, {})).status,
    409,
  );
});
test("MongoDB outage rejects queue work", async () => {
  await mongoose.connection.db.admin().command({ ping: 1 });
  await mongoose.connection.close();
  await assert.rejects(() => claim(new LockManager()));
  await mongoose.connect(config.MONGODB_URI);
});

test("lease expiry fencing prevents stale owner renewal or unlock", async () => {
  const first = new LockManager("first", 40);
  const second = new LockManager("second", 10000);
  const a = await first.acquire("test:expiry");
  await new Promise((r) => setTimeout(r, 80));
  const b = await second.acquire("test:expiry");
  assert(b.fence > a.fence);
  await assert.rejects(() => first.heartbeat("test:expiry"), {
    code: "LEASE_LOST",
  });
  await first.release("test:expiry");
  assert(await second.heartbeat("test:expiry"));
  await second.release("test:expiry");
});
test("strict pagination and settings DTO reject malformed input", async () => {
  assert.equal((await call("get", "/api/jobs?limit=1.5")).status, 400);
  assert.equal((await call("get", "/api/accounts?page=-1")).status, 400);
  assert.equal(
    (await call("patch", "/api/settings", { retentionDays: 0 })).status,
    400,
  );
  assert.equal(
    (await call("patch", "/api/settings", { groqApiKey: "never-accepted" }))
      .status,
    400,
  );
  const r = await call("get", "/api/settings");
  assert(!JSON.stringify(r.body).includes(config.SESSION_SECRET));
});

test("manual retry rejoins FIFO tail", async () => {
  await GenerationJob.deleteMany({});
  const a = await GoogleAccount.findOne();
  const d = {
    accountId: String(a._id),
    createNew: true,
    prompt: "retry FIFO",
    assetIds: [],
  };
  const first = await enqueue(d, "retry-tail-first");
  await new Promise((r) => setTimeout(r, 5));
  const second = await enqueue(d, "retry-tail-second");
  await GenerationJob.findByIdAndUpdate(first._id, { state: "failed" });
  const response = await call("post", `/api/jobs/${first._id}/retry`, {});
  assert.equal(response.status, 200);
  const lock = new LockManager();
  assert(await lock.acquire("worker"));
  try {
    assert.equal(String((await claim(lock))._id), String(second._id));
  } finally {
    await lock.release("worker");
  }
});
