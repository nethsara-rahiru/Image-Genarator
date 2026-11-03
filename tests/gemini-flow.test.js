import test from "node:test";
import assert from "node:assert/strict";
import { GeminiFlow, GOOGLE_LOGIN, GEMINI_URL } from "../src/geminiFlow.js";
import { nativeError } from "../src/native/common.js";

test("guided Google flow records actual commands and waits for human sign-in and confirmation", async () => {
  const actions = [],
    logs = [];
  const flow = new GeminiFlow(async (action) => actions.push(action), {
    write: (...args) => logs.push(args),
  });
  const first = flow.start();
  assert.equal(first.state, "starting");
  assert.throws(() => flow.start());
  assert.throws(() => flow.confirm(first.id));
  await flow.task;
  assert.deepEqual(actions, [
    { type: "start" },
    { type: "navigate", url: GOOGLE_LOGIN },
  ]);
  assert.equal(new URL(GOOGLE_LOGIN).hostname, "accounts.google.com");
  assert.equal(new URL(GOOGLE_LOGIN).searchParams.get("continue"), GEMINI_URL);
  assert.equal(flow.snapshot().state, "awaiting_signin");
  assert.throws(() => flow.proceed("stale"));
  flow.proceed(first.id);
  await flow.task;
  assert.deepEqual(actions.at(-1), { type: "navigate", url: GEMINI_URL });
  assert.equal(flow.snapshot().state, "awaiting_confirmation");
  const completed = flow.confirm(first.id);
  assert.equal(completed.state, "user_confirmed");
  assert.match(completed.message, /not been independently verified/);
  completed.steps.length = 0;
  assert.equal(flow.snapshot().steps.length, 6);
  assert.equal(logs.length, 6);
});

test("failed launches expose only sanitized errors and permit a new attempt", async () => {
  let fail = true;
  const flow = new GeminiFlow(async () => {
    if (fail) throw new Error("private-account-secret");
  });
  const first = flow.start();
  await flow.task;
  assert.equal(flow.snapshot().state, "failed");
  assert.ok(
    !JSON.stringify(flow.snapshot()).includes("private-account-secret"),
  );
  fail = false;
  const next = flow.start();
  assert.notEqual(first.id, next.id);
  await flow.task;
  flow.interrupted();
  assert.equal(flow.snapshot().state, "interrupted");
});

test("cancellation during startup waits for owned launch then stops without duplicate navigation", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actions = [];
  const flow = new GeminiFlow(async (action) => {
    actions.push(action.type);
    if (action.type === "start") await gate;
  });
  const { id } = flow.start();
  const cancelled = flow.cancel(id);
  assert.throws(() => flow.start());
  await assert.rejects(flow.cancel(id));
  release();
  await cancelled;
  assert.deepEqual(actions, ["start", "stop"]);
  assert.equal(flow.snapshot().state, "cancelled");
  await assert.rejects(flow.cancel(id));
});

test("navigation failures cannot be confirmed as authenticated", async () => {
  const flow = new GeminiFlow(async ({ type }) => {
    if (type === "navigate")
      throw nativeError("DESTINATION_BLOCKED", "Destination blocked.");
  });
  const { id } = flow.start();
  await flow.task;
  assert.equal(flow.snapshot().state, "failed");
  assert.equal(flow.snapshot().code, "DESTINATION_BLOCKED");
  assert.throws(() => flow.confirm(id));
});

test("interrupted startup cannot update a replacement flow", async () => {
  const resolvers = [];
  const actions = [];
  const flow = new GeminiFlow(async (action) => {
    actions.push(action);
    if (action.type === "start")
      await new Promise((resolve) => resolvers.push(resolve));
  });
  const first = flow.start();
  const oldTask = flow.task;
  flow.interrupted();
  const second = flow.start();
  resolvers[0]();
  await oldTask;
  assert.notEqual(first.id, second.id);
  assert.equal(flow.snapshot().state, "starting");
  assert.equal(actions.length, 2);
  resolvers[1]();
  await flow.task;
  assert.equal(flow.snapshot().state, "awaiting_signin");
  assert.equal(actions.filter((a) => a.type === "navigate").length, 1);
});
