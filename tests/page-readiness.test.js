import test from "node:test";
import assert from "node:assert/strict";
import { GenerationRunner } from "../src/generation/runner.js";
import { nativeError } from "../src/native/common.js";
import { configuration } from "../src/config.js";

function runner(observe, timeout = 1000) {
  const instance = new GenerationRunner({
    config: { generationReadyTimeoutMs: timeout },
    gemini: { observe },
  });
  instance.evaluate = async () => ({
    kind: "ready",
    editorReady: true,
    accountKey: "fixture",
  });
  return instance;
}
test("generation waits through unknown/loading/sign-in flashes until the loaded editor is ready", async () => {
  const states = ["loading", "signed_out", "unknown", "signed_in"];
  const instance = runner(
    async () => ({ kind: states.shift() || "signed_in" }),
    3000,
  );
  let inspections = 0;
  instance.evaluate = async () =>
    ++inspections === 1
      ? { kind: "loading" }
      : { kind: "ready", editorReady: true };
  assert.equal(
    (await instance.waitForPageReady({}, AbortSignal.timeout(5000)))
      .editorReady,
    true,
  );
  assert.equal(inspections, 2);
});
test("an unrecognized or incomplete editor reports readiness timeout, not a login failure", async () => {
  for (const kind of ["loading", "unknown", "signed_in"]) {
    const instance = runner(async () => ({ kind }), 10);
    instance.evaluate = async () => ({ kind: "ready", editorReady: false });
    await assert.rejects(
      instance.waitForPageReady({}, AbortSignal.timeout(2000)),
      { code: "GENERATION_PAGE_NOT_READY" },
    );
  }
});
test("only observed sign-in UI requires login; account mismatch and cancellation remain guarded", async () => {
  await assert.rejects(
    runner(async () => ({ kind: "signed_out" }), 10).waitForPageReady(
      {},
      AbortSignal.timeout(2000),
    ),
    { code: "GENERATION_LOGIN_REQUIRED" },
  );
  const instance = runner(async () => ({ kind: "signed_in" }));
  instance.evaluate = async () => {
    throw nativeError("GENERATION_ACCOUNT_CHANGED", "Account changed");
  };
  await assert.rejects(
    instance.waitForPageReady({}, AbortSignal.timeout(2000)),
    { code: "GENERATION_ACCOUNT_CHANGED" },
  );
  await assert.rejects(
    runner(async () => ({ kind: "loading" })).waitForPageReady(
      {},
      AbortSignal.abort(new Error("cancelled")),
    ),
    /cancelled/,
  );
});
test("readiness timeout has a bounded validated configuration", () => {
  assert.equal(configuration({}).generationReadyTimeoutMs, 45000);
  assert.equal(configuration({}).automationStepDelayMs, 1000);
  assert.equal(configuration({}).generationUploadTimeoutMs, 60000);
  assert.throws(() => configuration({ AUTOMATION_STEP_DELAY_MS: "5001" }));
  assert.throws(() =>
    configuration({ GENERATION_UPLOAD_TIMEOUT_SECONDS: "181" }),
  );
  assert.throws(() => configuration({ GENERATION_READY_TIMEOUT_SECONDS: "0" }));
  assert.throws(() =>
    configuration({ GENERATION_READY_TIMEOUT_SECONDS: "121" }),
  );
});
test("step pacing waits and remains cancellable before the next operation", async () => {
  const instance = runner(async () => ({ kind: "signed_in" }));
  instance.browser.config.automationStepDelayMs = 30;
  const started = Date.now();
  await instance.pace({}, "upload_files", AbortSignal.timeout(1000));
  assert.ok(Date.now() - started >= 25);
  instance.browser.config.automationStepDelayMs = 1000;
  let proceeded = false;
  await assert.rejects(
    instance.pace({}, "upload_files", AbortSignal.timeout(20)).then(() => {
      proceeded = true;
    }),
  );
  assert.equal(proceeded, false);
});

test("settling waits after readiness, rechecks a reload and keeps its account guard", async () => {
  const instance = runner(async () => ({ kind: "signed_in" }));
  instance.browser.options = { test: true, pageSettleMs: 30 };
  let reads = 0;
  const phases = [];
  instance.waitForPageReady = async (job) => {
    if (reads) assert.equal(job.accountKey, "fixture");
    return {
      kind: "ready",
      editorReady: true,
      accountKey: "fixture",
      documentId: ++reads,
      chatId: null,
    };
  };
  instance.evaluate = async () => ({
    kind: "ready",
    editorReady: true,
    documentId: 2,
    chatId: null,
  });
  const started = Date.now();
  await instance.waitForStablePage(
    {},
    AbortSignal.timeout(2000),
    async (phase) => phases.push(phase),
  );
  assert.ok(Date.now() - started >= 60);
  assert.equal(reads, 2);
  assert.deepEqual(phases, [
    "settling_page",
    "waiting_for_page",
    "settling_page",
  ]);
});

test("settling is cancellable before any post-wait operation", async () => {
  const instance = runner(async () => ({ kind: "signed_in" }));
  instance.browser.options = { test: true, pageSettleMs: 1000 };
  instance.waitForPageReady = async () => ({ accountKey: "fixture" });
  let inspections = 0;
  instance.evaluate = async () => {
    inspections++;
  };
  await assert.rejects(
    instance.waitForStablePage({}, AbortSignal.timeout(20), async () => {}),
  );
  assert.equal(inspections, 0);
});

test("read-only observation timeouts are retried within readiness, without inputs", async () => {
  let observations = 0;
  const instance = runner(async () => {
    if (++observations === 1)
      throw nativeError("AUTOMATION_TIMEOUT", "Observation timed out");
    return { kind: "signed_in" };
  });
  let inspections = 0;
  instance.evaluate = async (request) => {
    assert.equal(request.operation, "inspect");
    if (++inspections === 1)
      throw nativeError("AUTOMATION_TIMEOUT", "Observation timed out");
    return { kind: "ready", editorReady: true };
  };
  assert.equal(
    (await instance.waitForPageReady({}, AbortSignal.timeout(2000)))
      .editorReady,
    true,
  );
});
