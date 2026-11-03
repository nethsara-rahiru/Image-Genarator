import test from "node:test";
import assert from "node:assert/strict";
import { GeminiFlow } from "../src/geminiFlow.js";
import { nativeError } from "../src/native/common.js";
const view = (kind, site = "google", candidates = []) => ({
  kind,
  site,
  candidates,
  error: false,
});
function harness(views, extra = {}) {
  const actions = [],
    logs = [];
  const flow = new GeminiFlow(
    async (d) => {
      actions.push(d);
      if (d.command === "observe" || d.command === "fill") return views.shift();
    },
    { write: (...args) => logs.push(args) },
    extra.recovery,
  );
  return { flow, actions, logs };
}
test("Gemini is always first and verified signed-in UI stops without credentials or Groq", async () => {
  const { flow, actions } = harness([view("signed_in", "gemini")], {
    recovery: {
      propose: () => {
        throw Error("must not call");
      },
    },
  });
  flow.start();
  await flow.task;
  assert.equal(flow.snapshot().state, "already_signed_in");
  assert.equal(flow.snapshot().active, false);
  assert.equal(actions[0].automation, true);
  assert.deepEqual(
    actions.filter((d) => d.command === "open").map((d) => d.site),
    ["gemini"],
  );
  assert.ok(!flow.snapshot().input);
});
test("signed-out Gemini requests email then password, submits each once and observes completion", async () => {
  const { flow, actions, logs } = harness([
    view("signed_out", "gemini"),
    view("email"),
    view("password"),
    view("signed_in", "gemini"),
  ]);
  const { id } = flow.start();
  assert.throws(() => flow.start());
  await flow.task;
  assert.deepEqual(
    actions.filter((d) => d.command === "open").map((d) => d.site),
    ["gemini", "google"],
  );
  let input = flow.snapshot().input;
  assert.equal(input.kind, "email");
  assert.throws(() => flow.submit(id, "stale", "private-email"));
  flow.submit(id, input.token, "synthetic@example.test");
  assert.throws(() => flow.submit(id, input.token, "duplicate"));
  await flow.task;
  input = flow.snapshot().input;
  assert.equal(input.kind, "password");
  flow.submit(id, input.token, "synthetic-password");
  await flow.task;
  assert.equal(flow.snapshot().state, "signed_in");
  assert.equal(actions.filter((d) => d.command === "fill").length, 2);
  assert.ok(!JSON.stringify(flow.snapshot()).includes("synthetic"));
  assert.ok(!JSON.stringify(logs).includes("synthetic"));
});
test("security challenges hand off to the user and recheck never resubmits", async () => {
  const { flow, actions } = harness(
    [view("security_check"), view("verification"), view("signed_in", "gemini")],
    {
      recovery: {
        propose: () => {
          throw Error("no recovery on challenges");
        },
      },
    },
  );
  const { id } = flow.start();
  await flow.task;
  assert.equal(flow.snapshot().state, "awaiting_user");
  flow.proceed(id);
  await flow.task;
  assert.equal(flow.snapshot().input.kind, "verification");
  flow.submit(id, flow.snapshot().input.token, "123456");
  await flow.task;
  assert.equal(flow.snapshot().state, "signed_in");
  assert.equal(actions.filter((d) => d.command === "fill").length, 1);
});
test("ambiguous input failure requires review and cannot automatically replay a secret", async () => {
  const { flow, actions } = harness([view("email")]);
  const original = flow.action;
  flow.action = async (d) => {
    if (d.command === "fill") {
      actions.push(d);
      throw nativeError("INPUT_NEEDS_REVIEW", "Input may have been submitted.");
    }
    return original(d);
  };
  const { id } = flow.start();
  await flow.task;
  const token = flow.snapshot().input.token;
  flow.submit(id, token, "secret");
  await flow.task;
  assert.equal(flow.snapshot().state, "needs_review");
  assert.ok(!flow.snapshot().input);
  assert.throws(() => flow.submit(id, token, "secret"));
  assert.equal(actions.filter((d) => d.command === "fill").length, 1);
});
test("unknown-state recovery is bounded and all proposed clicks require allowed candidates", async () => {
  let calls = 0;
  const recovery = {
    propose: async () => {
      calls++;
      return { operation: "click", candidateId: "c1" };
    },
  };
  const unknown = view("unknown", "google", [{ id: "c1", action: "another" }]);
  const { flow, actions } = harness([unknown, unknown, unknown], { recovery });
  flow.start();
  await flow.task;
  assert.equal(calls, 2);
  assert.equal(flow.snapshot().state, "awaiting_user");
  assert.equal(actions.filter((d) => d.command === "click").length, 2);
  assert.throws(() => flow.confirm());
});
test("cancellation while launching aborts future navigation and closes only the owned browser", async () => {
  let release;
  const gate = new Promise((r) => (release = r)),
    actions = [];
  const flow = new GeminiFlow(async (d) => {
    actions.push(d);
    if (d.type === "start") await gate;
  });
  const { id } = flow.start();
  const cancel = flow.cancel(id);
  assert.throws(() => flow.start());
  await assert.rejects(flow.cancel(id));
  release();
  await cancel;
  assert.deepEqual(
    actions.map((d) => d.type),
    ["start", "stop"],
  );
  assert.equal(flow.snapshot().state, "cancelled");
});
test("raw browser exceptions and old input never enter flow snapshots", async () => {
  const flow = new GeminiFlow(async () => {
    throw Error("private-password-token");
  });
  flow.start();
  await flow.task;
  assert.equal(flow.snapshot().state, "needs_review");
  assert.ok(
    !JSON.stringify(flow.snapshot()).includes("private-password-token"),
  );
  flow.interrupted();
  assert.equal(flow.snapshot().state, "interrupted");
});
