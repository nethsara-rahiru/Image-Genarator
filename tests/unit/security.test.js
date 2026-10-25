import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedNavigation } from "../../src/services/browserManager.js";
import { safePath, chatUrl } from "../../src/utils/files.js";
import { sanitize } from "../../src/services/eventService.js";
import {
  proposal,
  GroqRecoveryAgent,
} from "../../src/services/groqRecoveryAgent.js";
test("constrain navigation and conversation URLs", () => {
  assert(allowedNavigation("https://gemini.google.com/app"));
  for (const u of [
    "http://gemini.google.com",
    "https://gemini.google.com.evil.test",
    "file:///etc/passwd",
    "https://evil.test",
    "https://user:pw@gemini.google.com",
  ])
    assert(!allowedNavigation(u));
  assert.equal(
    chatUrl("https://gemini.google.com/app/abc_123"),
    "https://gemini.google.com/app/abc_123",
  );
  assert.throws(() => chatUrl("https://accounts.google.com/app/x"));
  assert.throws(() => chatUrl("https://gemini.google.com/app/x?token=y"));
});
test("storage traversal and event redaction", () => {
  for (const name of ["../foo", "/etc/passwd", "..", "a/b", "a\\b"])
    assert.throws(() => safePath("/tmp/root", name));
  assert.equal(safePath("/tmp/root", "a.png"), "/tmp/root/a.png");
  assert(
    !sanitize("user@example.com token=supersecret").includes("supersecret"),
  );
  assert(!sanitize("user@example.com").includes("user@"));
});
test("LLM proposals reject injection and arbitrary operations", () => {
  assert.throws(() => proposal.parse({ operation: "shell", candidateId: 0 }));
  assert.throws(() =>
    proposal.parse({
      operation: "navigate",
      candidateId: 0,
      url: "https://evil.test",
    }),
  );
  assert.throws(() => proposal.parse({ operation: "click", candidateId: -1 }));
  assert.throws(() =>
    proposal.parse({
      operation: "click",
      candidateId: 0,
      javascript: "steal()",
    }),
  );
});
test("disabled Groq never transmits data", async () => {
  let calls = 0;
  const groq = new GroqRecoveryAgent(
    { GROQ_API_KEY: "test" },
    { groqEnabled: false },
    () => {
      calls++;
    },
  );
  await assert.rejects(() => groq.choose("send", []), {
    code: "LOCATOR_NOT_FOUND",
  });
  assert.equal(calls, 0);
});

test("Ubuntu OS lock excludes a second process until first exits", async () => {
  const { spawn, spawnSync } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-flock-"));
  const file = path.join(folder, "worker.lock");
  const holder = spawn("flock", [
    "--nonblock",
    "--no-fork",
    file,
    process.execPath,
    "-e",
    'process.stdout.write("ready");setTimeout(()=>{},10000)',
  ]);
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", resolve);
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`holder exit ${code}`)));
    });
    assert.equal(spawnSync("flock", ["--nonblock", file, "true"]).status, 1);
    const done = new Promise((r) => holder.once("exit", r));
    holder.kill("SIGTERM");
    await done;
    assert.equal(spawnSync("flock", ["--nonblock", file, "true"]).status, 0);
  } finally {
    holder.kill();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("monitor refuses login and unauthenticated pages before any capture", async () => {
  const { captureMonitor } =
    await import("../../src/services/monitorService.js");
  const response = {
    locator: () => {
      throw new Error("Must never inspect login image");
    },
  };
  assert.equal(
    await captureMonitor({ login: true, page: {} }, response, {}, {}, {}),
    false,
  );
  assert.equal(
    await captureMonitor(
      {
        login: false,
        page: { url: () => "https://accounts.google.com/signin" },
      },
      response,
      {},
      {},
      {},
    ),
    false,
  );
});
