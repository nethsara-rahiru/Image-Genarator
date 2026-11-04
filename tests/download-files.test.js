import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GenerationRunner } from "../src/generation/runner.js";
import { png } from "./fixtures/png.js";
for (const mode of ["missing-events", "ephemeral-frame", "ambiguous-files"]) {
  const ambiguous = mode === "ambiguous-files";
  test(`named download checks completed original files without Chrome completion events (${mode})`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "named-image-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pipe = new EventEmitter();
    let downloadPath;
    pipe.send = async (method, params) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "managed-frame" } } };
      if (method === "Browser.setDownloadBehavior" && params.eventsEnabled) {
        assert.equal(params.behavior, "allow");
        downloadPath = params.downloadPath;
        assert.notEqual(downloadPath, directory);
      }
      if (
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseReleased"
      ) {
        if (mode === "ephemeral-frame") {
          pipe.emit("Page.frameAttached", {
            frameId: "ephemeral",
            parentFrameId: "managed-frame",
          });
          pipe.emit("Browser.downloadWillBegin", {
            frameId: "ephemeral",
            guid: "822ce7ee-b783-4114-9777-e23d9fb5d985",
          });
          pipe.emit("Page.frameDetached", { frameId: "ephemeral" });
        }
        await fs.writeFile(
          path.join(downloadPath, "original.png.crdownload"),
          png(),
        );
        if (ambiguous)
          await fs.writeFile(path.join(downloadPath, "other.png"), png(50));
        await fs.rename(
          path.join(downloadPath, "original.png.crdownload"),
          path.join(downloadPath, "original.png"),
        );
      }
      return {};
    };
    const browser = {
      pipe,
      gemini: { session: "session" },
      downloadDir: directory,
    };
    const runner = new GenerationRunner(browser);
    runner.evaluate = async ({ operation }) =>
      operation === "inspect"
        ? { selection: { imageId: "image", buttonId: "button" } }
        : { ok: true, x: 30, y: 30 };
    const download = runner.download({
      selection: { imageId: "image", buttonId: "button" },
      directory,
      signal: new AbortController().signal,
    });
    if (ambiguous)
      await assert.rejects(download, { code: "GENERATION_DOWNLOAD_AMBIGUOUS" });
    else {
      const file = await download;
      assert.equal(path.basename(file), "original.png");
      assert.ok((await fs.readFile(file)).equals(png()));
    }
    assert.equal(pipe.listenerCount("Browser.downloadProgress"), 0);
    assert.equal(pipe.listenerCount("Page.frameAttached"), 0);
  });
}

for (const mode of [
  "moves-once",
  "always-moving",
  "image-changes",
  "chat-changes",
]) {
  test(`download control reacquisition: ${mode}`, async () => {
    let hovered = false,
      coordinates = 0;
    const events = [];
    const browser = {
      gemini: { session: "session" },
      pipe: {
        async send(method, params) {
          events.push(params.type);
          if (params.type === "mouseMoved") hovered = true;
        },
      },
    };
    const runner = new GenerationRunner(browser);
    runner.evaluate = async ({ operation }) => {
      if (operation === "inspect")
        return {
          chatId:
            mode === "chat-changes" && hovered
              ? "different-chat"
              : "saved-chat",
          selection: {
            imageKey:
              mode === "image-changes" && hovered
                ? "other-image"
                : "original-image",
            imageId: "image",
            responseId: "response",
            buttonId: hovered ? "replacement-button" : "first-button",
          },
        };
      return {
        ok: true,
        x:
          mode === "always-moving"
            ? 30 + (coordinates++ % 2) * 24
            : hovered
              ? 54
              : 30,
        y: 30,
      };
    };
    const control = runner.stableDownloadControl(
      {
        selection: { imageKey: "original-image", imageId: "image" },
        expectedChatId: "saved-chat",
      },
      new AbortController().signal,
    );
    if (mode === "moves-once") {
      assert.deepEqual(await control, { ok: true, x: 54, y: 30 });
      assert.equal(events.filter((event) => event === "mouseMoved").length, 2);
    } else
      await assert.rejects(control, {
        code:
          mode === "always-moving"
            ? "GENERATION_DOWNLOAD_UNSTABLE"
            : "GENERATION_DOWNLOAD_CHANGED",
      });
    assert.ok(
      !events.includes("mousePressed"),
      "reacquisition must never click or submit",
    );
  });
}

for (const mode of [
  "input-ack",
  "frame-ack",
  "cleanup-ack",
  "telemetry-error",
]) {
  test(
    `completed file handoff does not wait for Chrome ${mode}`,
    { timeout: 5000 },
    async (t) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "independent-download-"),
      );
      let unpause;
      const blocked = new Promise((resolve) => {
        unpause = resolve;
      });
      t.after(async () => {
        unpause();
        await fs.rm(directory, { recursive: true, force: true });
      });
      const pipe = new EventEmitter();
      let downloadPath,
        frameCalls = 0;
      const presses = [];
      pipe.send = async (method, params) => {
        if (method === "Page.getFrameTree") {
          if (++frameCalls > 1 && mode === "frame-ack") await blocked;
          return {
            frameTree: {
              frame: { id: "main" },
              childFrames: [{ frame: { id: "download-frame" } }],
            },
          };
        }
        if (method === "Browser.setDownloadBehavior" && params.eventsEnabled)
          downloadPath = params.downloadPath;
        if (method === "Network.disable" && mode === "cleanup-ack")
          await blocked;
        if (method === "Network.disable" && mode === "telemetry-error")
          throw Error("Synthetic renderer ACK timeout");
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mousePressed"
        ) {
          presses.push(params.type);
          if (mode === "input-ack") await blocked;
        }
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased"
        ) {
          presses.push(params.type);
          if (mode === "frame-ack")
            pipe.emit("Browser.downloadWillBegin", {
              frameId: "late-frame",
              guid: "822ce7ee-b783-4114-9777-e23d9fb5d985",
              url: "https://gemini.google.com/image-download",
            });
          await fs.writeFile(path.join(downloadPath, "original.png"), png(80));
          if (mode === "input-ack") await blocked;
        }
        return {};
      };
      const runner = new GenerationRunner({
        pipe,
        gemini: { session: "session" },
        downloadDir: directory,
      });
      runner.evaluate = async ({ operation }) =>
        operation === "inspect"
          ? { selection: { imageId: "image", buttonId: "button" } }
          : { ok: true, x: 30, y: 30 };
      const file = await runner.download({
        selection: { imageId: "image", buttonId: "button" },
        directory,
        signal: new AbortController().signal,
      });
      assert.ok((await fs.readFile(file)).equals(png(80)));
      assert.deepEqual(presses, ["mousePressed", "mouseReleased"]);
      if (mode === "cleanup-ack")
        assert.equal(runner.downloadCleanupPending, true);
      unpause();
      await runner.waitForDownloadCleanup();
      assert.equal(runner.downloadCleanupPending, false);
    },
  );
}

test("an unrelated-origin download is not accepted as the selected image", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "foreign-download-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pipe = new EventEmitter();
  pipe.send = async (method, params) => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "managed" } } };
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type === "mouseReleased"
    )
      pipe.emit("Browser.downloadWillBegin", {
        guid: "822ce7ee-b783-4114-9777-e23d9fb5d985",
        frameId: "other-page",
        url: "https://unrelated.example/image.png",
      });
    return {};
  };
  const runner = new GenerationRunner({
    pipe,
    gemini: { session: "session" },
    downloadDir: directory,
  });
  runner.evaluate = async ({ operation }) =>
    operation === "inspect"
      ? { selection: { imageId: "image", buttonId: "button" } }
      : { ok: true, x: 30, y: 30 };
  await assert.rejects(
    runner.download({
      selection: { imageId: "image", buttonId: "button" },
      directory,
      signal: new AbortController().signal,
    }),
    { code: "GENERATION_DOWNLOAD_FRAME_UNVERIFIED" },
  );
  await runner.waitForDownloadCleanup();
});
