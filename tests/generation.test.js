import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { GenerationQueue } from "../src/generation/queue.js";
import { imageInfo } from "../src/generation/imageInfo.js";
import { nativeError } from "../src/native/common.js";
import { configuration } from "../src/config.js";
import { startServer } from "../src/server.js";
import { png } from "./fixtures/png.js";
async function until(fn) {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await pause(20);
  }
  throw Error("Condition timed out");
}
async function queue(t, runner) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "image-queue-"));
  const q = new GenerationQueue(
    { ...configuration({ DATA_DIR: data }), generationTimeoutMs: 5000 },
    runner,
  );
  await q.init();
  t.after(async () => {
    await q.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  return q;
}
function successRunner(steps = []) {
  return {
    async run(job, { directory, phase, chat }) {
      steps.push(job.prompt);
      await phase("submitting_prompt", {
        submissionPossible: true,
        accountKey: "account-a",
      });
      await chat(
        "actual-chat-" + job.sequence,
        "https://gemini.google.com/app/actual-chat-" + job.sequence,
        "account-a",
      );
      await fs.mkdir(directory, { recursive: true });
      const bytes = png(job.sequence);
      await fs.writeFile(path.join(directory, "image.png"), bytes);
      return { ...imageInfo(bytes), filename: "image.png" };
    },
  };
}
test("download metadata uses original bytes and rejects incomplete/non-image output", () => {
  const bytes = png(),
    info = imageInfo(bytes);
  assert.equal(info.width, 64);
  assert.equal(info.height, 64);
  assert.equal(info.format, "png");
  assert.equal(info.bytes, bytes.length);
  assert.equal(info.checksum.length, 64);
  assert.throws(() => imageInfo(bytes.subarray(0, 40)));
  assert.throws(() => imageInfo(Buffer.from("<html>not an image</html>")));
});
test("durable FIFO runs one job at a time, returns real-style chat IDs and preserves output bytes", async (t) => {
  const seen = [],
    q = await queue(t, successRunner(seen));
  const first = await q.create({
    prompt: "first image",
    idempotencyKey: "first-key-0001",
  });
  const second = await q.create({
    prompt: "second image",
    idempotencyKey: "second-key-0002",
  });
  await until(() => q.data.jobs.every((j) => j.state === "completed"));
  assert.deepEqual(seen, ["first image", "second image"]);
  assert.equal(q.get(first.id).chatId, "actual-chat-1");
  assert.equal(q.snapshot().chats.length, 2);
  const file = await q.outputFile(first.id),
    metadata = await q.outputFile(first.id, true);
  assert.ok((await fs.readFile(file.path)).equals(png(1)));
  assert.equal(
    JSON.parse(await fs.readFile(metadata.path, "utf8")).chatId,
    "actual-chat-1",
  );
  assert.equal(q.get(second.id).state, "completed");
  const duplicate = await q.create({
    prompt: "first image",
    idempotencyKey: "first-key-0001",
  });
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    q.create({ prompt: "changed", idempotencyKey: "first-key-0001" }),
  );
  await assert.rejects(q.outputFile("../../outside"));
  await q.renameChat("actual-chat-1", "Local title");
  assert.equal(q.snapshot().chats[0].title, "Local title");
});
test("queue lease excludes another owner and submitted work recovers as needs_review", async (t) => {
  const q = await queue(t, {
    run: async () => {
      throw Error("unused");
    },
  });
  const second = new GenerationQueue(q.config, {});
  await assert.rejects(second.init());
  const job = await q.create({
    prompt: "pending",
    idempotencyKey: "restart-key-0001",
  });
  await until(() => q.get(job.id).state === "failed");
  q.get(job.id).state = "generating";
  q.get(job.id).submissionPossible = true;
  await q.persist();
  await q.close();
  const reopened = new GenerationQueue(q.config, {});
  await reopened.init();
  try {
    assert.equal(reopened.get(job.id).state, "needs_review");
    await assert.rejects(reopened.retry(job.id));
  } finally {
    await reopened.close();
  }
});
test("login failures allow explicit retry but potentially submitted prompts do not", async (t) => {
  let loggedIn = false;
  const runner = successRunner();
  const q = await queue(t, {
    run: async (job, context) => {
      if (!loggedIn)
        throw nativeError("GENERATION_LOGIN_REQUIRED", "Login required.");
      return runner.run(job, context);
    },
  });
  const { id } = await q.create({
    prompt: "image",
    idempotencyKey: "login-key-00001",
  });
  await until(() => q.get(id).state === "needs_login");
  loggedIn = true;
  await q.retry(id);
  await until(() => q.get(id).state === "completed");
  assert.equal(q.get(id).attempts, 2);
  await assert.rejects(q.retry(id));
});
test("queued/running cancellation retains duplicate-submission protection", async (t) => {
  const q = await queue(t, {
    async run(job, { signal, phase }) {
      await phase("submitting_prompt", { submissionPossible: true });
      await pause(10000, undefined, { signal });
    },
  });
  const a = await q.create({ prompt: "a", idempotencyKey: "cancel-key-0001" });
  const b = await q.create({ prompt: "b", idempotencyKey: "cancel-key-0002" });
  await until(() => q.get(a.id).submissionPossible);
  await q.cancel(b.id);
  await q.cancel(a.id);
  await until(() => q.get(a.id).state === "cancelled");
  assert.equal(q.get(b.id).state, "cancelled");
  await assert.rejects(q.retry(a.id));
});
test("local no-login API works without an admin and retains Host/Origin/CSRF boundaries", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "open-generator-"));
  const config = {
    ...configuration({ DATA_DIR: data, AUTO_OPEN: "false" }),
    port: 0,
  };
  const service = await startServer(config, {
    test: true,
    generationRunner: successRunner(),
  });
  const base = `http://127.0.0.1:${service.port}`;
  config.origin = base;
  t.after(async () => {
    await service.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  let response = await fetch(base + "/api/session");
  const session = await response.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.authRequired, false);
  const cookie = response.headers.getSetCookie()[0].split(";")[0];
  const headers = {
    Cookie: cookie,
    Origin: base,
    "X-CSRF-Token": session.csrf,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(base + "/api/generation/jobs", {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": "bad" },
        body: "{}",
      })
    ).status,
    403,
  );
  response = await fetch(base + "/api/generation/jobs", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "blue square",
      idempotencyKey: "api-first-key-0001",
    }),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  await until(() => service.generation.get(job.id).state === "completed");
  assert.equal(
    (
      await fetch(base + "/api/generation/jobs/" + job.id + "/image", {
        headers: { Cookie: cookie },
      })
    ).status,
    200,
  );
  assert.equal(
    configuration({ PUBLIC_ORIGIN: "https://public.example" }).authRequired,
    false,
  );
  const unexpectedHost = await new Promise((resolve, reject) => {
    const req = http.request(
      base + "/api/session",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(unexpectedHost, 403);
});

test("concurrent duplicate requests execute once and repeated deletion cannot remove a different job", async (t) => {
  const seen = [],
    q = await queue(t, successRunner(seen));
  const jobs = await Promise.all(
    Array.from({ length: 12 }, () =>
      q.create({
        prompt: "same request",
        idempotencyKey: "concurrent-key-0001",
      }),
    ),
  );
  assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
  await until(() => q.get(jobs[0].id).state === "completed");
  assert.equal(seen.length, 1);
  const second = await q.create({
    prompt: "other request",
    idempotencyKey: "concurrent-key-0002",
  });
  await until(() => q.get(second.id).state === "completed");
  const deleted = await Promise.allSettled([
    q.remove(jobs[0].id),
    q.remove(jobs[0].id),
  ]);
  assert.equal(deleted.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(q.data.jobs.length, 1);
  assert.equal(q.data.jobs[0].id, second.id);
});
test("explicit retries go behind already queued work", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r)),
    order = [];
  const success = successRunner();
  const q = await queue(t, {
    async run(job, context) {
      order.push(job.prompt);
      if (job.prompt === "A" && job.attempts === 1)
        throw nativeError("GENERATION_LOGIN_REQUIRED", "Sign-in required.");
      if (job.prompt === "B") await gate;
      return success.run(job, context);
    },
  });
  const a = await q.create({ prompt: "A", idempotencyKey: "fifo-retry-key-a" });
  await until(() => q.get(a.id).state === "needs_login");
  await q.create({ prompt: "B", idempotencyKey: "fifo-retry-key-b" });
  await until(() => q.active?.prompt === "B");
  await q.create({ prompt: "C", idempotencyKey: "fifo-retry-key-c" });
  await q.retry(a.id);
  release();
  await until(() => q.data.jobs.every((j) => j.state === "completed"));
  assert.deepEqual(order, ["A", "B", "C", "A"]);
});
test("shutdown and timeouts do not requeue a potentially submitted prompt", async (t) => {
  const q = await queue(t, {
    async run(job, { phase, signal }) {
      await phase("submitting_prompt", { submissionPossible: true });
      await pause(5000, undefined, { signal });
    },
  });
  q.config.generationTimeoutMs = 60;
  const job = await q.create({
    prompt: "timeout",
    idempotencyKey: "timeout-test-key",
  });
  await until(() => q.get(job.id).state === "needs_review");
  assert.equal(q.get(job.id).error.code, "GENERATION_TIMEOUT");
  q.config.generationTimeoutMs = 5000;
  const stop = await q.create({
    prompt: "shutdown",
    idempotencyKey: "shutdown-test-key",
  });
  await until(() => q.get(stop.id).submissionPossible);
  await q.close();
  const disk = JSON.parse(await fs.readFile(q.file, "utf8"));
  assert.equal(disk.jobs.find((j) => j.id === stop.id).state, "needs_review");
});
test("corrupt storage is preserved and output symlinks are rejected", async (t) => {
  const q = await queue(t, successRunner());
  const job = await q.create({
    prompt: "safe",
    idempotencyKey: "symlink-safe-key",
  });
  await until(() => q.get(job.id).state === "completed");
  const file = await q.outputFile(job.id);
  if (process.platform !== "win32") {
    await fs.rm(file.path);
    const outside = path.join(q.config.data, "outside.png");
    await fs.writeFile(outside, png());
    await fs.symlink(outside, file.path);
    await assert.rejects(q.outputFile(job.id));
  }
  await q.close();
  await fs.writeFile(q.file, "broken-journal");
  const reopened = new GenerationQueue(q.config, {});
  await assert.rejects(reopened.init());
  assert.equal(await fs.readFile(q.file, "utf8"), "broken-journal");
});

test("download recovery preserves submission marker and is distinct from prompt retry", async (t) => {
  let calls = 0;
  const q = await queue(t, {
    async run(job, context) {
      calls++;
      if (!job.downloadOnly) {
        await context.phase("downloading", {
          submissionPossible: true,
          accountKey: "account-a",
          downloadCheckpoint: { imageKey: "a".repeat(64) },
        });
        await context.chat(
          "saved-chat",
          "https://gemini.google.com/app/saved-chat",
          "account-a",
        );
        throw nativeError("GENERATION_DOWNLOAD_TIMEOUT", "No download event");
      }
      assert.equal(job.submissionPossible, true);
      await fs.mkdir(context.directory, { recursive: true });
      await fs.writeFile(path.join(context.directory, "image.png"), png());
      return { ...imageInfo(png()), filename: "image.png" };
    },
  });
  const job = await q.create({
    prompt: "image",
    idempotencyKey: "recover-key",
  });
  await until(() => q.get(job.id).state === "needs_review");
  assert.equal(q.publicJob(q.get(job.id)).canRecoverDownload, true);
  await assert.rejects(q.retry(job.id), /already have been submitted/);
  await q.recover(job.id);
  await until(() => q.get(job.id).state === "completed");
  assert.equal(calls, 2);
  await assert.rejects(q.recover(job.id), /no verified download-stage/);
});

test("manual image attachment validates bytes and consent, preserves job and never resubmits", async (t) => {
  let submissions = 0;
  const q = await queue(t, {
    async run(job, context) {
      submissions++;
      await context.phase("submitting_prompt", {
        submissionPossible: true,
        accountKey: "account-a",
      });
      await context.chat(
        "manual-chat",
        "https://gemini.google.com/app/manual-chat",
        "account-a",
      );
      await context.phase("downloading", {
        downloadCheckpoint: { imageKey: "a".repeat(64) },
      });
      throw nativeError("GENERATION_DOWNLOAD_TIMEOUT", "No file arrived");
    },
  });
  const job = await q.create({
    prompt: "original image",
    idempotencyKey: "manual-image-request",
  });
  await until(() => q.get(job.id).state === "needs_review" && !q.busy);
  await assert.rejects(q.importManual(job.id, png(), false), /confirm/);
  await assert.rejects(
    q.importManual(job.id, Buffer.from("<html>not an image</html>"), true),
  );
  const imported = await q.importManual(job.id, png(100), true);
  assert.equal(imported.state, "completed");
  assert.equal(imported.output.source, "manual_import");
  assert.equal(imported.chatId, "manual-chat");
  assert.equal(submissions, 1);
  assert.ok(
    (await fs.readFile((await q.outputFile(job.id)).path)).equals(png(100)),
  );
  const metadata = JSON.parse(
    await fs.readFile((await q.outputFile(job.id, true)).path),
  );
  assert.equal(metadata.association, "user_confirmed");
  assert.equal(metadata.associationVerified, false);
  await assert.rejects(q.importManual(job.id, png(), true));
  if (process.platform !== "win32") {
    const other = await q.create({
      prompt: "another image",
      idempotencyKey: "manual-image-request-2",
    });
    await until(() => q.get(other.id).state === "needs_review" && !q.busy);
    const escape = await fs.mkdtemp(path.join(os.tmpdir(), "manual-escape-"));
    t.after(() => fs.rm(escape, { recursive: true, force: true }));
    await fs.symlink(escape, path.join(q.outputs, other.id), "dir");
    await assert.rejects(
      q.importManual(other.id, png(), true),
      /Unsafe output directory/,
    );
    assert.deepEqual(await fs.readdir(escape), []);
  }
});

test("completed output is published before browser cleanup, but the next job waits", async (t) => {
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const runner = successRunner();
  const run = runner.run;
  runner.downloadCleanupPending = true;
  runner.run = async (...args) => {
    runs++;
    return run(...args);
  };
  runner.waitForDownloadCleanup = async () => {
    await cleanup;
    runner.downloadCleanupPending = false;
  };
  const q = await queue(t, runner);
  try {
    const first = await q.create({
      prompt: "first",
      idempotencyKey: "first-cleanup-key",
    });
    const second = await q.create({
      prompt: "second",
      idempotencyKey: "second-cleanup-key",
    });
    await until(
      () =>
        q.get(first.id).state === "completed" &&
        q.publicJob(q.get(first.id)).browserCleanupPending,
    );
    assert.equal(q.get(second.id).state, "queued");
    assert.equal(runs, 1);
    const bytes = await fs.readFile((await q.outputFile(first.id)).path);
    assert.ok(bytes.equals(png(1)));
    // Await the commit, not just its in-memory assignment.
    await until(
      async () =>
        JSON.parse(await fs.readFile(q.file, "utf8")).jobs[0].state ===
        "completed",
    );
    assert.equal(q.busy, true);
    release();
    await until(() => q.get(second.id).state === "completed");
    assert.equal(runs, 2);
  } finally {
    release();
  }
});

test("failed browser cleanup retains completed output and stops further generation", async (t) => {
  const runner = successRunner();
  runner.waitForDownloadCleanup = async () => {
    runner.downloadCleanupError = nativeError(
      "GENERATION_BROWSER_RESET_REQUIRED",
      "Restart required; output retained.",
    );
    throw runner.downloadCleanupError;
  };
  const q = await queue(t, runner);
  const first = await q.create({
    prompt: "saved output",
    idempotencyKey: "cleanup-failure-key",
  });
  await until(
    () => q.get(first.id).state === "completed" && q.stopping && !q.busy,
  );
  assert.ok(
    (await fs.readFile((await q.outputFile(first.id)).path)).equals(png(1)),
  );
  assert.ok(q.snapshot().cleanupError);
  await assert.rejects(
    q.create({ prompt: "next", idempotencyKey: "must-not-start-key" }),
    { code: "GENERATION_BROWSER_RESET_REQUIRED" },
  );
});
