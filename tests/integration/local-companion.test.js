import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import request from "supertest";
import session from "express-session";
import mongoose from "mongoose";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  connect,
  GoogleAccount,
  GenerationJob,
  GeneratedOutput,
  LocalDevice,
  DevicePairing,
  Lease,
  GeminiChat,
} from "../../src/models/index.js";
import { createApp } from "../../src/app.js";
import { storage } from "../../src/utils/files.js";
import { tokenHash } from "../../src/routes/companion.js";
import { enqueue, LockManager } from "../../src/services/jobQueue.js";
import { expireRuns } from "../../src/services/local/jobs.js";
let mongo, config, app, device, token, account, browserId;
const origin = "https://localhost:3443";
function call(method, url, body, key = token) {
  let r = request(app)
    [method]("/api/companion" + url)
    .set("Host", "localhost:3443")
    .set("X-Forwarded-Proto", "https");
  if (key) r = r.set("Authorization", `Bearer ${key}`);
  if (body) r = r.send(body);
  return r;
}
async function reset() {
  await GenerationJob.deleteMany({});
  await Lease.deleteMany({});
  account.state = "ready";
  await account.save();
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri());
  config = {
    EXECUTION_MODE: "local",
    MONGODB_URI: mongo.getUri(),
    SESSION_SECRET: "x".repeat(40),
    PUBLIC_ORIGIN: origin,
    DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "local-protocol-")),
    LEASE_MS: 30000,
    GENERATION_TIMEOUT_MS: 30000,
  };
  await storage(config);
  app = createApp(config, {}, { store: new session.MemoryStore() }).app;
  const code = crypto.randomBytes(18).toString("base64url");
  await DevicePairing.create({
    name: "Test PC",
    codeHash: tokenHash(code),
    expiresAt: new Date(Date.now() + 60000),
  });
  const paired = await call(
    "post",
    "/pair",
    { code, name: "fixture", platform: "test" },
    null,
  );
  assert.equal(paired.status, 200);
  token = paired.body.deviceToken;
  device = await LocalDevice.findById(paired.body.deviceId);
  browserId = crypto.randomUUID();
  await call("post", "/heartbeat", {
    browsers: [{ id: browserId, label: "Chrome profile" }],
  });
  device = await LocalDevice.findById(device._id);
  account = await GoogleAccount.create({
    email: "local@example.test",
    executionMode: "local",
    deviceId: device._id,
    browserId,
    state: "ready",
  });
  assert.equal(
    (
      await call(
        "post",
        "/pair",
        { code, name: "again", platform: "test" },
        null,
      )
    ).status,
    403,
  );
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(config.DATA_DIR, { recursive: true, force: true });
});
test("device authorization and job asset scopes are enforced", async () => {
  assert.equal((await call("get", "/state", null, "wrong")).status, 401);
  assert.equal((await call("get", "/state")).status, 200);
  assert(!JSON.stringify((await call("get", "/state")).body).includes(token));
  const otherToken = crypto.randomBytes(32).toString("base64url");
  await LocalDevice.create({
    name: "other",
    tokenHash: tokenHash(otherToken),
    expiresAt: new Date(Date.now() + 60000),
  });
  await reset();
  const j = await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "scope",
      assetIds: [],
    },
    "local-scope-key",
  );
  const claim = await call("post", "/claim", {});
  assert.equal(claim.status, 200);
  const run = { runId: claim.body.job.runId, fence: claim.body.job.fence };
  assert.equal(
    (
      await call(
        "post",
        `/jobs/${j._id}/progress`,
        { ...run, state: "uploading_assets" },
        otherToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "get",
        `/jobs/${j._id}/assets/000000000000000000000001?runId=${run.runId}&fence=${run.fence}`,
      )
    ).status,
    403,
  );
});
test("local FIFO claim is exclusive across competing requests", async () => {
  await reset();
  await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "first",
      assetIds: [],
    },
    "local-first-key",
  );
  await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "second",
      assetIds: [],
    },
    "local-second-key",
  );
  const results = await Promise.all(
    Array.from({ length: 6 }, () => call("post", "/claim", {})),
  );
  const jobs = results.filter((r) => r.body.job);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].body.job.prompt, "first");
});
test("single-use submission permit erects a durable global barrier; output releases it", async () => {
  await reset();
  const j = await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "image",
      assetIds: [],
    },
    "local-output-key",
  );
  const claimed = (await call("post", "/claim", {})).body.job;
  assert(claimed);
  const run = { runId: claimed.runId, fence: claimed.fence };
  assert.equal(
    (
      await call("post", `/jobs/${j._id}/progress`, {
        ...run,
        state: "submitting_prompt",
      })
    ).status,
    200,
  );
  assert.equal((await call("post", `/jobs/${j._id}/permit`, run)).status, 200);
  assert.equal((await call("post", `/jobs/${j._id}/permit`, run)).status, 409);
  assert.equal(
    String((await Lease.findById("worker")).blockedJobId),
    String(j._id),
  );
  const competitor = new LockManager();
  assert.equal(await competitor.acquire("worker"), null);
  await call("post", `/jobs/${j._id}/progress`, {
    ...run,
    state: "generating",
    chatUrl: "https://gemini.google.com/app/localFixture",
  });
  await call("post", `/jobs/${j._id}/progress`, {
    ...run,
    state: "downloading",
  });
  const image = await sharp({
    create: { width: 24, height: 16, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const response = await request(app)
    .post(`/api/companion/jobs/${j._id}/output`)
    .set("Host", "localhost:3443")
    .set("X-Forwarded-Proto", "https")
    .set("Authorization", `Bearer ${token}`)
    .field("runId", run.runId)
    .field("fence", String(run.fence))
    .attach("image", image, "original.png");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.metadata.width, 24);
  assert.equal((await GenerationJob.findById(j._id)).state, "completed");
  assert.equal((await Lease.findById("worker")).blockedJobId, undefined);
  assert.equal(await GeneratedOutput.countDocuments({ jobId: j._id }), 1);
});
test("expired local run after submission remains blocked and is never automatically resubmitted", async () => {
  await reset();
  const j = await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "uncertain",
      assetIds: [],
    },
    "local-uncertain-key",
  );
  const c = (await call("post", "/claim", {})).body.job;
  const run = { runId: c.runId, fence: c.fence };
  await call("post", `/jobs/${j._id}/progress`, {
    ...run,
    state: "submitting_prompt",
  });
  await call("post", `/jobs/${j._id}/permit`, run);
  await GenerationJob.updateOne(
    { _id: j._id },
    { $set: { leaseUntil: new Date(0) } },
  );
  await Lease.updateOne(
    { _id: "worker" },
    { $set: { expiresAt: new Date(0) } },
  );
  await expireRuns(config);
  const stored = await GenerationJob.findById(j._id);
  assert.equal(stored.state, "needs_review");
  assert(stored.remoteUncertain);
  assert.equal((await call("post", "/claim", {})).body.reason, "needs_review");
  assert.equal(await new LockManager().acquire("worker"), null);
});
test("lost pre-submission browser run safely rejoins the queue", async () => {
  await reset();
  const j = await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "not sent",
      assetIds: [],
    },
    "local-unsubmitted-key",
  );
  await call("post", "/claim", {});
  await GenerationJob.updateOne(
    { _id: j._id },
    { $set: { leaseUntil: new Date(0) } },
  );
  await Lease.updateOne(
    { _id: "worker" },
    { $set: { expiresAt: new Date(0) } },
  );
  await expireRuns(config);
  assert.equal((await GenerationJob.findById(j._id)).state, "queued");
  assert.equal((await Lease.findById("worker")).blockedJobId, undefined);
});

test("completed output lookup survives a lost acknowledgement and releases orphan barriers", async () => {
  await reset();
  const j = await enqueue(
    {
      accountId: String(account._id),
      createNew: true,
      prompt: "saved result",
      assetIds: [],
    },
    "local-saved-result-key",
  );
  const run = (await call("post", "/claim", {})).body.job;
  const saved = await GeneratedOutput.create({
    jobId: j._id,
    accountId: account._id,
    filename: "fixture.png",
    bytes: 5,
    width: 1,
    height: 1,
    format: "png",
  });
  await GenerationJob.updateOne(
    { _id: j._id },
    { $set: { state: "completed", outputId: saved._id } },
  );
  await Lease.updateOne({ _id: "worker" }, { $set: { blockedJobId: j._id } });
  await expireRuns(config);
  assert.equal((await Lease.findById("worker")).blockedJobId, undefined);
  const known = await call(
    "get",
    `/jobs/${j._id}/result?runId=${run.runId}&fence=${run.fence}`,
  );
  assert.equal(known.status, 200);
  assert.equal(known.body.state, "completed");
  assert.equal(known.body.outputId, String(saved._id));
});
test("stale account commands cannot operate another binding and profile identity is unique", async () => {
  await reset();
  const { enqueueCommand, claimCommand } =
    await import("../../src/services/local/commands.js");
  await enqueueCommand(account, "verify");
  const original = account.browserId;
  account.browserId = crypto.randomUUID();
  await account.save();
  assert.equal(await claimCommand(device, config, [original]), null);
  account.browserId = original;
  await account.save();
  await assert.rejects(
    () =>
      GoogleAccount.create({
        email: "duplicate@example.test",
        executionMode: "local",
        deviceId: device._id,
        browserId: original,
      }),
    { code: 11000 },
  );
});
