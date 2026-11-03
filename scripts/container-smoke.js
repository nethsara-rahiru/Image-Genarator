// Run inside the production image. No Google/network navigation or real credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteBrowser } from "../src/browser.js";
const data = await fs.mkdtemp(path.join(os.tmpdir(), "background-sandbox-"));
const browser = new RemoteBrowser(
  { data, chromePath: "/usr/bin/chromium" },
  { homepage: "about:blank" },
);
try {
  assert.notEqual(process.getuid(), 0);
  await browser.start(true);
  assert.ok((await browser.pipe.send("Browser.getVersion")).product);
  const frame = await browser.capture();
  const state = await browser.state();
  assert.equal(state.backgroundInput, true);
  assert.equal(state.frameReady, true);
  assert.ok(frame.length > 100);
  console.log(
    "Production non-root Chromium sandbox, private automation pipe, desktop and JPEG capture OK.",
  );
} finally {
  await browser.stop();
  await fs.rm(data, { recursive: true, force: true });
}
