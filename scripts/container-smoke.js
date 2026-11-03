// Run inside the production image. No Google/network navigation or real credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configuration } from "../src/config.js";
import { startServer } from "../src/server.js";
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
  const config = {
    ...configuration({ DATA_DIR: path.join(data, "api"), AUTO_OPEN: "false" }),
    port: 0,
  };
  const service = await startServer(config);
  config.origin = `http://127.0.0.1:${service.port}`;
  try {
    const session = await (await fetch(config.origin + "/api/session")).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.authRequired, false);
    assert.equal(await service.admin(), null);
    assert.equal(
      (await (await fetch(config.origin + "/api/generation")).json()).jobs
        .length,
      0,
    );
  } finally {
    await service.close();
  }
  console.log(
    "Production non-root Chromium sandbox, private automation pipe, desktop, capture and no-login generator API OK.",
  );
} finally {
  await browser.stop();
  await fs.rm(data, { recursive: true, force: true });
}
