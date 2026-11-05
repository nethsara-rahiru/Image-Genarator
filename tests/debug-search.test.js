import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { navigationTarget } from "../src/navigation.js";
import { DebugLog } from "../src/debugLog.js";
import { actionError } from "../src/actionErrors.js";
test("automation diagnostics retain safe targets/counts but omit page text, paths and tokens", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "automation-trace-"));
  try {
    const log = new DebugLog(data, { stdout: false });
    const entry = log.write(
      "info",
      "browser",
      "AUTOMATION_TRACE",
      "Upload discovery snapshot.",
      {
        stage: "upload_discovery",
        outcome: "waiting",
        target: "composer_plus",
        reason: "click_required",
        jobId: "12345678-1234-1234-1234-123456789abc",
        candidateCount: 0,
        composerFound: 1,
        plusInsideCount: 1,
        plusOutsideCount: 2,
        rectX: 22.4,
        rectY: 200,
        rectWidth: 32,
        rectHeight: 32,
        label: "Google Account: private@example.test",
        prompt: "secret prompt",
        token: "secret token",
        path: "/private/profile",
        targetToken: "private-node-token",
        inputCount: -1,
      },
    );
    assert.equal(entry.details.target, "composer_plus");
    assert.equal(entry.details.rectX, 22);
    assert.equal(entry.details.plusOutsideCount, 2);
    assert.equal(entry.details.inputCount, undefined);
    assert.doesNotMatch(
      JSON.stringify(entry),
      /private@example|secret prompt|secret token|private-node-token|private\/profile/,
    );
    const restored = new DebugLog(data, { stdout: false }).snapshot().entries;
    assert.deepEqual(restored[0].details, entry.details);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});
test("address bar distinguishes Google searches, domains, ports and explicit schemes", () => {
  assert.equal(
    navigationTarget("weather in colombo"),
    "https://www.google.com/search?q=weather%20in%20colombo",
  );
  assert.equal(
    navigationTarget("gemini"),
    "https://www.google.com/search?q=gemini",
  );
  assert.equal(navigationTarget("google.com"), "https://google.com/");
  assert.equal(
    navigationTarget("example.com:8443/a"),
    "https://example.com:8443/a",
  );
  assert.equal(
    navigationTarget("https://example.com/a?q=b"),
    "https://example.com/a?q=b",
  );
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://127.0.0.1",
  ])
    assert.equal(navigationTarget(value), value);
  assert.throws(() => navigationTarget(" "));
});
test("debug journal rotates, replays, filters sensitive metadata, survives restart and clears disk history", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "debug-journal-"));
  try {
    const log = new DebugLog(data, {
      stdout: false,
      maxEntries: 3,
      maxBytes: 1000,
    });
    const first = log.write("info", "server", "TEST", "Synthetic diagnostic.", {
      text: "secret-password",
      url: "https://example.com/?token=hidden",
      action: "navigate",
      durationMs: 12,
    });
    for (let i = 0; i < 8; i++)
      log.write("warn", "network", "REQUEST_FAILED", "A request failed.", {
        networkCode: "net::ERR_NAME_NOT_RESOLVED",
        status: 503,
      });
    assert.equal(log.snapshot().entries.length, 3);
    const encoded = JSON.stringify(log.snapshot());
    assert.doesNotMatch(encoded, /secret-password|token=hidden/);
    assert.equal(log.snapshot(log.snapshot().cursor).entries.length, 0);
    assert.equal(log.snapshot(first.id).entries.length, 3);
    assert.ok((await fs.stat(`${log.file}.1`)).size > 0);
    const restored = new DebugLog(data, {
      stdout: false,
      maxEntries: 3,
      maxBytes: 1000,
    });
    assert.equal(restored.snapshot().entries.length, 3);
    const old = restored.generation;
    restored.clear();
    assert.notEqual(restored.generation, old);
    assert.equal(restored.snapshot().entries.length, 1);
    assert.equal(
      new DebugLog(data, { stdout: false, maxBytes: 1000 }).snapshot().entries
        .length,
      1,
    );
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});
test("action diagnostics expose actionable network and state codes without raw error text", () => {
  for (const [text, code] of [
    ["page.goto: net::ERR_NAME_NOT_RESOLVED secret=private", "DNS_FAILED"],
    ["net::ERR_CERT_AUTHORITY_INVALID token=hidden", "TLS_FAILED"],
    ["Private addresses are blocked", "DESTINATION_BLOCKED"],
    ["Timeout 20000ms exceeded", "ACTION_TIMEOUT"],
    ["Start the browser first", "BROWSER_CLOSED"],
    ["unknown password=private", "ACTION_FAILED"],
  ]) {
    const result = actionError(new Error(text));
    assert.equal(result.code, code);
    assert.doesNotMatch(
      result.message,
      /secret=private|token=hidden|password=private/,
    );
  }
});
