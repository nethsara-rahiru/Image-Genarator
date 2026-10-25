import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  connect,
  GoogleAccount,
  GenerationJob,
  GeneratedOutput,
  GeminiChat,
  Asset,
  Setting,
  Lease,
} from "../../src/models/index.js";
import { deleteOutput } from "../../src/services/outputManager.js";
import { Worker } from "../../src/workers/runner.js";
import { enqueue, recover } from "../../src/services/jobQueue.js";
import { storage } from "../../src/utils/files.js";
import { storeAsset } from "../../src/services/assetUploader.js";
import {
  signedIn,
  allowedNavigation,
} from "../../src/services/browserManager.js";
import { GroqRecoveryAgent } from "../../src/services/groqRecoveryAgent.js";
let mongo, browser, config, png;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri());
  browser = await chromium.launch();
  config = {
    DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "gemini-worker-")),
    LEASE_MS: 10000,
    GENERATION_TIMEOUT_MS: 3000,
    GROQ_API_KEY: "test",
    GROQ_MODEL: "test",
  };
  await storage(config);
  png = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  await Setting.create({ _id: "global", generationTimeoutMs: 3000 });
});
after(async () => {
  await browser.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(config.DATA_DIR, { recursive: true, force: true });
});
function fixture(mode = "success") {
  return `<style>img{width:100px;height:100px}</style><input type="file" multiple><div contenteditable="true" role="textbox"></div><button aria-label="Send message">Send</button><script>document.querySelector('input').onchange=e=>{for(const f of e.target.files){const n=document.createElement('div');n.className='attachment-preview';n.textContent=f.name;document.body.append(n)}};document.querySelector('button').onclick=()=>{history.pushState({},'', '/app/fixtureChat${mode === "success" ? "" : "NoImage"}');const r=document.createElement('model-response');r.innerHTML=${JSON.stringify(mode === "no-image" ? '<p>Text response only</p><span data-test-id="response-complete"></span>' : `<div><img src="data:image/png;base64,${png?.toString("base64")}"><button aria-label="Download image">Download</button></div>`)};document.body.append(r);if(r.querySelector('button'))r.querySelector('button').onclick=()=>{const a=document.createElement('a');a.href='data:image/png;base64,${png?.toString("base64")}';a.download='image.png';a.click()};};</script>`;
}
function manager(mode) {
  const sessions = [];
  return {
    open: async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      await context.route("https://gemini.google.com/**", (r) =>
        r.fulfill({ contentType: "text/html", body: fixture(mode) }),
      );
      const page = await context.newPage();
      await page.goto("https://gemini.google.com/app");
      const s = { context, page, login: false, close: () => context.close() };
      sessions.push(s);
      return s;
    },
    close: async () => {
      for (const s of sessions) await s.close().catch(() => {});
    },
  };
}
test("full worker fixture uploads assets, creates chat, saves exactly one original and JSON", async () => {
  const a = await GoogleAccount.create({
    email: "fixture@example.test",
    state: "ready",
  });
  const asset = await storeAsset(
    { buffer: png, size: png.length, originalname: "reference.png" },
    config,
  );
  const j = await enqueue(
    {
      accountId: String(a._id),
      createNew: true,
      prompt: "Create test image",
      assetIds: [String(asset._id)],
    },
    "full-worker-fixture",
  );
  const worker = new Worker(config, manager("success"));
  await worker.start();
  try {
    assert(await worker.tick());
    const job = await GenerationJob.findById(j._id);
    assert.equal(job.state, "completed", JSON.stringify(job.error));
    const output = await GeneratedOutput.findById(job.outputId);
    assert.equal(output.width, 32);
    assert.equal(output.height, 24);
    assert.equal(output.bytes, png.length);
    assert.equal(output.metadata.inputAssets[0], "reference.png");
    const data = await fs.readFile(
      path.join(config.DATA_DIR, "outputs", output.filename),
    );
    assert.deepEqual(data, png);
    assert(
      (
        await fs.stat(
          path.join(
            config.DATA_DIR,
            "monitor",
            (await Lease.findById("worker")).snapshotFilename,
          ),
        )
      ).size > 0,
    );
    assert.equal(
      (await GeminiChat.findById(job.chatId)).url,
      "https://gemini.google.com/app/fixtureChat",
    );
    assert.equal(await GeneratedOutput.countDocuments({ jobId: j._id }), 1);
    await GenerationJob.findByIdAndUpdate(j._id, { state: "downloading" });
    await recover();
    assert.equal((await GenerationJob.findById(j._id)).state, "completed");
    await deleteOutput(output, config);
    assert.equal((await Lease.findById("worker")).snapshotAt, undefined);
  } finally {
    await worker.stop();
  }
});
test("worker returns failed NO_IMAGE and does not fabricate output", async () => {
  const a = await GoogleAccount.create({
    email: "no-image@example.test",
    state: "ready",
  });
  const j = await enqueue(
    {
      accountId: String(a._id),
      createNew: true,
      prompt: "Text response",
      assetIds: [],
    },
    "no-image-fixture",
  );
  const worker = new Worker(config, manager("no-image"));
  await worker.start();
  try {
    await worker.tick();
    const job = await GenerationJob.findById(j._id);
    assert.equal(job.state, "failed", JSON.stringify(job.error));
    assert.equal(job.error.code, "NO_IMAGE");
    assert.equal(await GeneratedOutput.countDocuments({ jobId: j._id }), 0);
  } finally {
    await worker.stop();
  }
});
test("expired account pauses before browser submission", async () => {
  const a = await GoogleAccount.create({
    email: "expired@example.test",
    state: "expired",
  });
  const j = await enqueue(
    {
      accountId: String(a._id),
      createNew: true,
      prompt: "never submit",
      assetIds: [],
    },
    "expired-fixture",
  );
  const worker = new Worker(config, {
    open: () => {
      throw new Error("Should never open");
    },
    close: async () => {},
  });
  await worker.start();
  try {
    await worker.tick();
    assert.equal((await GenerationJob.findById(j._id)).state, "needs_login");
  } finally {
    await worker.stop();
  }
});
test("signed-in detection rejects expired login UI", async () => {
  const p = await browser.newPage();
  await p.route("https://gemini.google.com/**", (r) =>
    r.fulfill({ body: '<a href="https://accounts.google.com">Sign in</a>' }),
  );
  await p.goto("https://gemini.google.com/app");
  assert.equal(await signedIn(p), false);
  await p.close();
});
test("Groq network timeout and malformed candidates fail boundedly", async () => {
  let calls = 0;
  const agent = new GroqRecoveryAgent(
    config,
    { groqEnabled: true, groqModel: "test" },
    async () => {
      calls++;
      throw new DOMException("timeout", "TimeoutError");
    },
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      () =>
        agent.choose("composer", [
          { tag: "DIV", role: "textbox", label: "Prompt" },
        ]),
      { code: "GROQ_FAILED" },
    );
  await assert.rejects(() => agent.choose("composer", []), {
    code: "RECOVERY_BUDGET",
  });
  assert.equal(calls, 3);
  const malicious = new GroqRecoveryAgent(
    config,
    { groqEnabled: true },
    async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ operation: "shell", candidateId: 0 }),
              },
            },
          ],
        }),
    }),
  );
  await assert.rejects(() => malicious.choose("composer", []), {
    code: "GROQ_FAILED",
  });
});
test("persistent Chromium profiles isolate cookies and survive restart", async () => {
  const p1 = path.join(config.DATA_DIR, "profiles", "fixtureA"),
    p2 = path.join(config.DATA_DIR, "profiles", "fixtureB");
  let a = await chromium.launchPersistentContext(p1, { headless: true });
  await a.addCookies([
    {
      name: "session",
      value: "A",
      domain: "gemini.google.com",
      path: "/",
      secure: true,
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
  await a.close();
  a = await chromium.launchPersistentContext(p1, { headless: true });
  const b = await chromium.launchPersistentContext(p2, { headless: true });
  assert.equal(
    (await a.cookies()).find((c) => c.name === "session")?.value,
    "A",
  );
  assert.equal((await b.cookies()).length, 0);
  await a.close();
  await b.close();
});
