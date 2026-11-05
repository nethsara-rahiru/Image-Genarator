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
  assert.throws(() => configuration({ GENERATION_READY_TIMEOUT_SECONDS: "0" }));
  assert.throws(() =>
    configuration({ GENERATION_READY_TIMEOUT_SECONDS: "121" }),
  );
});
