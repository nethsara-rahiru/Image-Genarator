import test from "node:test";
import assert from "node:assert/strict";
import { GeminiFlow } from "../src/geminiFlow.js";
for (const kind of [
  "signed_out",
  "email",
  "password",
  "verification",
  "account_chooser",
  "unknown",
  "blocked",
]) {
  test(`manual login never fills/clicks/recovers ${kind}`, async () => {
    const actions = [];
    const flow = new GeminiFlow(
      async (action) => {
        actions.push(action);
        if (action.command === "observe") return { kind, site: "gemini" };
      },
      null,
      {
        propose() {
          throw Error("must not call Groq");
        },
      },
    );
    flow.start();
    await flow.task;
    assert.equal(flow.snapshot().state, "awaiting_user");
    assert.equal(flow.snapshot().input, undefined);
    assert.deepEqual(
      actions.map((a) => a.command || a.type),
      ["start", "open", "observe"],
    );
    assert.throws(
      () => flow.submit("id", "token", "secret"),
      /directly in Chrome/,
    );
  });
}
test("manual completion is verified in Gemini", async () => {
  let signedIn = false;
  const flow = new GeminiFlow(async (action) => {
    if (action.command === "observe")
      return { kind: signedIn ? "signed_in" : "signed_out", site: "gemini" };
  });
  flow.start();
  await flow.task;
  signedIn = true;
  flow.proceed(flow.snapshot().id);
  await flow.task;
  assert.equal(flow.snapshot().state, "signed_in");
  assert.equal(flow.snapshot().active, false);
});
