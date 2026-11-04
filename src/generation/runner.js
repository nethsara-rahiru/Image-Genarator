import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { generationPage } from "./page.js";
import { imageInfo } from "./imageInfo.js";
import { nativeError } from "../native/common.js";
export class GenerationRunner {
  constructor(browser, action) {
    this.browser = browser;
    this.action = action;
  }
  async evaluate(request, signal) {
    signal.throwIfAborted();
    const adapter = this.browser.gemini;
    request = { ...this.recoveryRequest, ...request };
    const result = await this.browser.pipe.send(
      "Runtime.evaluate",
      {
        expression: `(${generationPage.toString()})(${JSON.stringify({ ...request, ...(this.browser.options.test && this.browser.options.automationOrigins ? { origin: this.browser.options.automationOrigins.gemini } : {}) })})`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      },
      adapter.session,
    );
    signal.throwIfAborted();
    if (result.exceptionDetails || !result.result?.value)
      throw nativeError(
        "GENERATION_PAGE_CHANGED",
        "The generation page changed unexpectedly. Inspect the saved chat before retrying.",
      );
    const value = result.result.value;
    if (value.kind === "needs_login")
      throw nativeError(
        "GENERATION_LOGIN_REQUIRED",
        "Sign in manually in the opened Chrome window, then retry this job.",
      );
    if (value.kind === "account_changed")
      throw nativeError(
        "GENERATION_ACCOUNT_CHANGED",
        "This chat belongs to a different Google account. Restore that account or create a new chat.",
      );
    if (value.kind === "restricted")
      throw nativeError(
        "GENERATION_RESTRICTED",
        "Gemini reports an account or usage restriction. No retry or account-switch workaround will be attempted.",
      );
    if (value.kind === "recovery_unverified")
      throw nativeError(
        "GENERATION_RECOVERY_UNVERIFIED",
        "Could not uniquely associate an image with this job in the saved chat. Download manually from Gemini; no prompt was submitted.",
      );
    return value;
  }
  async run(job, { signal, directory, phase, chat }) {
    this.recoveryRequest = job.downloadOnly
      ? job.downloadCheckpoint?.imageKey
        ? { recoverImageKey: job.downloadCheckpoint.imageKey }
        : { recoverPrompt: job.submittedPrompt }
      : {};
    await this.action({ type: "start", automation: true });
    signal.throwIfAborted();
    const adapter = this.browser.gemini;
    await adapter.open("gemini", job.chatId);
    const login = await adapter.observe({ signal });
    if (login.kind !== "signed_in")
      throw nativeError(
        "GENERATION_LOGIN_REQUIRED",
        "Sign in manually in the opened Chrome window, then retry this job. No prompt was submitted.",
      );
    let before = await this.evaluate(
      { operation: "inspect", accountKey: job.accountKey },
      signal,
    );
    if (job.chatId && before.chatId !== job.chatId)
      throw nativeError(
        "GENERATION_CHAT_UNAVAILABLE",
        "Gemini did not open the requested saved chat. No prompt was submitted.",
      );
    let selected, accountKey, baseline, baselineImages;
    if (job.downloadOnly) {
      accountKey = before.accountKey;
      baseline = [];
      baselineImages = [];
      if (!before.selection || before.busy)
        throw nativeError(
          "GENERATION_RECOVERY_UNVERIFIED",
          "The saved response has no completed, verified image to download. No prompt was submitted.",
        );
      selected = before.selection;
    } else {
      if (!job.chatId && (before.responseIds.length || before.chatId)) {
        const result = await this.evaluate(
          { operation: "new_chat", accountKey: before.accountKey },
          signal,
        );
        if (!result.ok)
          throw nativeError(
            "GENERATION_NEW_CHAT",
            "Could not verify a new Gemini chat. No prompt was submitted.",
          );
        for (let n = 0; n < 20; n++) {
          await pause(250, undefined, { signal });
          before = await this.evaluate(
            { operation: "inspect", accountKey: before.accountKey },
            signal,
          );
          if (!before.chatId && !before.responseIds.length) break;
        }
        if (before.chatId || before.responseIds.length)
          throw nativeError(
            "GENERATION_NEW_CHAT",
            "A fresh empty chat could not be verified. No prompt was submitted.",
          );
      }
      if (!before.editorReady)
        throw nativeError(
          "GENERATION_EDITOR",
          "The Gemini prompt editor was not recognized. No prompt was submitted.",
        );
      accountKey = before.accountKey;
      baseline = before.responseIds;
      baselineImages = before.imageKeys;

      await phase("preparing_prompt", { accountKey });
      const filled = await this.evaluate(
        { operation: "fill_prompt", accountKey, prompt: job.submittedPrompt },
        signal,
      );
      if (!filled.ok)
        throw nativeError(
          "GENERATION_EDITOR",
          "The prompt editor changed. No prompt was submitted.",
        );
      let ready;
      for (let n = 0; n < 20; n++) {
        ready = await this.evaluate(
          { operation: "inspect", accountKey, baseline, baselineImages },
          signal,
        );
        if (ready.canSend) break;
        await pause(150, undefined, { signal });
      }
      if (!ready?.canSend)
        throw nativeError(
          "GENERATION_SEND_UNAVAILABLE",
          "The Send button was not available. No prompt was submitted.",
        );
      await phase("submitting_prompt", { submissionPossible: true });
      const submitted = await this.evaluate(
        {
          operation: "send",
          accountKey,
          prompt: job.submittedPrompt,
          baseline,
        },
        signal,
      );
      if (!submitted.ok) {
        await phase("preparing_prompt", { submissionPossible: false });
        throw nativeError(
          "GENERATION_NOT_SUBMITTED",
          "The editor, account or response baseline changed. No prompt was submitted.",
        );
      }
      await phase("generating");

      while (true) {
        signal.throwIfAborted();
        const state = await this.evaluate(
          { operation: "inspect", accountKey, baseline, baselineImages },
          signal,
        );
        if (state.chatId) await chat(state.chatId, state.chatUrl, accountKey);
        if (state.selection && !state.busy && state.chatId) {
          selected = state.selection;
          break;
        }
        if (state.textOnly)
          throw nativeError(
            "GENERATION_NO_IMAGE",
            "Gemini completed a text-only response: no valid generated image was returned.",
          );
        await pause(500, undefined, { signal });
      }
    }
    await phase("downloading", {
      downloadCheckpoint: { imageKey: selected.imageKey },
    });
    const source = await this.download({
      selection: selected,
      accountKey,
      baseline,
      baselineImages,
      directory,
      signal,
    });
    const stat = await fs.lstat(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !stat.size ||
      stat.size > 100 * 1024 * 1024
    )
      throw nativeError(
        "GENERATION_INVALID_DOWNLOAD",
        "The downloaded image is empty, unsafe or exceeds 100 MB.",
      );
    const data = await fs.readFile(source),
      info = imageInfo(data),
      filename = "image." + info.format;
    await fs.rename(source, path.join(directory, filename));
    await fs.rmdir(path.dirname(source)).catch(() => {});
    this.browser.log?.write(
      "info",
      "browser",
      "IMAGE_DOWNLOAD_VERIFIED",
      "Original image bytes and dimensions verified; output saved to this job.",
    );
    return { ...info, filename };
  }
  async download({
    selection,
    accountKey,
    baseline,
    baselineImages,
    directory,
    signal,
  }) {
    const pipe = this.browser.pipe,
      adapter = this.browser.gemini;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const hover = await this.evaluate(
      {
        operation: "hover_image",
        selection,
        accountKey,
        baseline,
        baselineImages,
      },
      signal,
    );
    if (!hover.ok)
      throw nativeError(
        "GENERATION_DOWNLOAD_CHANGED",
        "The current image changed before download.",
      );
    await pipe.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: hover.x,
        y: hover.y,
      },
      adapter.session,
    );
    // Gemini reveals its image toolbar on hover. Reobserve the same image only.
    for (let n = 0; n < 20; n++) {
      const state = await this.evaluate(
        { operation: "inspect", accountKey, baseline, baselineImages },
        signal,
      );
      if (state.selection?.imageId !== selection.imageId)
        throw nativeError(
          "GENERATION_DOWNLOAD_CHANGED",
          "The current image changed before download.",
        );
      if (state.selection.buttonId) {
        selection = state.selection;
        break;
      }
      await pause(150, undefined, { signal });
    }
    if (!selection.buttonId)
      throw nativeError(
        "GENERATION_DOWNLOAD_UNAVAILABLE",
        "The generated image is visible but its original-image download control was not found. Open the saved chat to download it manually; the prompt will not be resubmitted.",
      );
    const { frameTree } = await pipe.send(
      "Page.getFrameTree",
      {},
      adapter.session,
    );
    const frames = new Set();
    const collect = (node) => {
      frames.add(node.frame.id);
      for (const child of node.childFrames || []) collect(child);
    };
    collect(frameTree);
    const attemptDirectory = await fs.mkdtemp(
      path.join(directory, "download-"),
    );
    await fs.chmod(attemptDirectory, 0o700);
    let guid, timer, resolve, reject;
    let completed = false,
      finished = false;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {});
    let pendingGuid, pendingProgress;
    let unverifiedFrame = false,
      polling = false,
      pollTimer,
      previousFile,
      previousBytes = 0,
      stable = 0,
      transferCompleted = false;
    const attached = (event) => {
      if (frames.has(event.parentFrameId)) frames.add(event.frameId);
    };
    const pollFile = async () => {
      if (polling || finished || unverifiedFrame || pendingGuid) return;
      polling = true;
      try {
        const names = await fs.readdir(attemptDirectory);
        if (finished) return;
        const partials = names.filter((name) =>
          /\.(crdownload|tmp|part)$/i.test(name),
        );
        const files = names.filter((name) => !partials.includes(name));
        if (files.length > 1)
          throw nativeError(
            "GENERATION_DOWNLOAD_AMBIGUOUS",
            "Multiple files arrived during this download. No file was selected; inspect the saved chat.",
          );
        let bytes = 0;
        for (const name of names) {
          const stat = await fs.lstat(path.join(attemptDirectory, name));
          if (!stat.isFile() || stat.isSymbolicLink())
            throw nativeError(
              "GENERATION_INVALID_DOWNLOAD",
              "An unsafe download file was rejected.",
            );
          bytes += stat.size;
        }
        if (bytes > 100 * 1024 * 1024)
          throw nativeError(
            "GENERATION_DOWNLOAD_TOO_LARGE",
            "The image download exceeds 100 MB.",
          );
        if (finished) return;
        if (bytes > previousBytes) {
          previousBytes = bytes;
          armTimeout(60000);
        }
        if (partials.length || files.length !== 1) {
          stable = 0;
          return;
        }
        const file = path.join(attemptDirectory, files[0]);
        const data = await fs.readFile(file);
        try {
          imageInfo(data);
        } catch (error) {
          if (transferCompleted) throw error;
          return;
        }
        const fingerprint =
          files[0] + ":" + data.length + ":" + imageInfo(data).checksum;
        stable = fingerprint === previousFile ? stable + 1 : 0;
        previousFile = fingerprint;
        if (stable < 2 || finished) return;
        completed = true;
        this.browser.log?.write(
          "info",
          "browser",
          "IMAGE_DOWNLOAD_FILE_READY",
          "A single complete image file was verified in this job's isolated download folder.",
        );
        resolve(file);
      } catch (error) {
        if (!finished && error.code !== "ENOENT") reject(error);
      } finally {
        polling = false;
      }
    };
    const accept = (event) => {
      if (finished) {
        pipe
          .send("Browser.cancelDownload", { guid: event.guid })
          .catch(() => {});
        return;
      }
      if (guid) return;
      guid = event.guid;
      armTimeout(60000);
      this.browser.log?.write(
        "info",
        "browser",
        "IMAGE_DOWNLOAD_STARTED",
        "Chrome reported an image download from the managed page.",
      );
      if (pendingProgress?.guid === guid) progress(pendingProgress);
    };
    const begin = (event) => {
      if (
        finished ||
        guid ||
        pendingGuid ||
        !/^[a-f0-9-]{16,80}$/i.test(event.guid)
      )
        return;
      if (frames.has(event.frameId)) {
        accept(event);
        return;
      }
      // Google can create its download iframe after the toolbar click.
      pendingGuid = event.guid;
      pipe
        .send("Page.getFrameTree", {}, adapter.session)
        .then(({ frameTree }) => {
          collect(frameTree);
          if (frames.has(event.frameId)) accept(event);
          else {
            unverifiedFrame = true;
            this.browser.log?.write(
              "warn",
              "browser",
              "IMAGE_DOWNLOAD_FRAME_UNVERIFIED",
              "Chrome reported a download outside the verified page frames; it was not accepted.",
            );
          }
        })
        .catch(() => {})
        .finally(() => {
          pendingGuid = null;
        });
    };
    let receivedBytes = 0;
    const progress = (event) => {
      if (event.guid !== guid) {
        if (event.guid === pendingGuid) pendingProgress = event;
        return;
      }
      if (event.receivedBytes > receivedBytes) {
        receivedBytes = event.receivedBytes;
        armTimeout(60000);
      }
      if (event.receivedBytes > 100 * 1024 * 1024) {
        reject(
          nativeError(
            "GENERATION_DOWNLOAD_TOO_LARGE",
            "The image download exceeds 100 MB and was cancelled.",
          ),
        );
        return;
      }
      if (event.state === "completed") {
        transferCompleted = true;
        void pollFile();
      } else if (event.state === "canceled")
        reject(
          nativeError(
            "GENERATION_DOWNLOAD_INTERRUPTED",
            "Gemini's image download was interrupted. Inspect the chat; the prompt will not be resubmitted.",
          ),
        );
    };
    let clicked = false,
      preparationCount = 0,
      failedRequests = 0,
      popupCount = 0;
    const preparation = new Set();
    const networkRequest = (event) => {
      if (!clicked || finished || preparation.size >= 64) return;
      try {
        const url = new URL(event.request.url);
        const testOrigin =
          this.browser.options?.test &&
          this.browser.options.automationOrigins?.gemini;
        const allowed =
          url.protocol === "https:" &&
          (url.hostname === "gemini.google.com" ||
            /(^|\.)googleusercontent\.com$/.test(url.hostname));
        if (
          !(allowed || (testOrigin && url.origin === testOrigin)) ||
          !["Image", "Fetch", "XHR"].includes(event.type)
        )
          return;
        preparation.add(event.requestId);
        preparationCount++;
        armTimeout(60000);
        if (preparationCount === 1)
          this.browser.log?.write(
            "info",
            "browser",
            "IMAGE_DOWNLOAD_PREPARING",
            "An image/service request was observed after the download click. Waiting for the provider to prepare the file.",
          );
      } catch {
        /* URLs and request contents never leave this callback. */
      }
    };
    const networkFinished = (event) => {
      preparation.delete(event.requestId);
    };
    const networkFailed = (event) => {
      if (preparation.delete(event.requestId)) {
        failedRequests++;
        this.browser.log?.write(
          "warn",
          "browser",
          "IMAGE_DOWNLOAD_REQUEST_FAILED",
          "A provider image/preparation request failed; no URL or request contents were recorded.",
        );
      }
    };
    const popup = () => {
      if (clicked && !finished) {
        popupCount++;
        this.browser.log?.write(
          "warn",
          "browser",
          "IMAGE_DOWNLOAD_WINDOW_OPENED",
          "The download action opened another window. Inspect Chrome on the host if no file arrives.",
        );
      }
    };
    const abort = () =>
      reject(
        signal.reason ||
          nativeError("GENERATION_CANCELLED", "Generation cancelled."),
      );
    pipe.on("Network.requestWillBeSent", networkRequest);
    pipe.on("Network.loadingFinished", networkFinished);
    pipe.on("Network.loadingFailed", networkFailed);
    pipe.on("Page.windowOpen", popup);
    pipe.on("Page.frameAttached", attached);
    pipe.on("Browser.downloadWillBegin", begin);
    pipe.on("Browser.downloadProgress", progress);
    signal.addEventListener("abort", abort, { once: true });
    function armTimeout(ms) {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          reject(
            nativeError(
              "GENERATION_DOWNLOAD_TIMEOUT",
              guid
                ? "Chrome started the download but stopped transferring image bytes for 60 seconds. Use Download existing image; no prompt will be resubmitted."
                : `No completed file arrived after the image click (preparation requests: ${preparationCount}, failed requests: ${failedRequests}, new windows: ${popupCount}). Retry Download existing image, or manually download from the saved chat and use Attach downloaded image. No prompt will be resubmitted.`,
            ),
          ),
        ms,
      );
    }
    armTimeout(30000);
    try {
      signal.throwIfAborted();
      await pipe.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: attemptDirectory,
        eventsEnabled: true,
      });
      await pipe.send("Page.enable", {}, adapter.session);
      await pipe.send("Network.enable", {}, adapter.session);
      pollTimer = setInterval(() => {
        void pollFile();
      }, 300);
      let result = await this.evaluate(
        {
          operation: "download",
          selection,
          accountKey,
          baseline,
          baselineImages,
        },
        signal,
      );
      if (!result.ok)
        throw nativeError(
          "GENERATION_DOWNLOAD_CHANGED",
          "The selected current-response image changed. No download was started.",
        );
      await pipe.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: result.x, y: result.y },
        adapter.session,
      );
      const checked = await this.evaluate(
        {
          operation: "download",
          selection,
          accountKey,
          baseline,
          baselineImages,
        },
        signal,
      );
      if (
        !checked.ok ||
        Math.abs(checked.x - result.x) > 1 ||
        Math.abs(checked.y - result.y) > 1
      )
        throw nativeError(
          "GENERATION_DOWNLOAD_CHANGED",
          "The download control moved or changed before the click. No new prompt was submitted.",
        );
      result = checked;
      clicked = true;
      await pipe.send(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: result.x,
          y: result.y,
          button: "left",
          clickCount: 1,
        },
        adapter.session,
      );
      await pipe.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: result.x,
          y: result.y,
          button: "left",
          clickCount: 1,
        },
        adapter.session,
      );
      this.browser.log?.write(
        "info",
        "browser",
        "IMAGE_DOWNLOAD_CLICKED",
        "Original-image download control clicked using browser input.",
      );
      return await completion;
    } finally {
      finished = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      pipe.off("Network.requestWillBeSent", networkRequest);
      pipe.off("Network.loadingFinished", networkFinished);
      pipe.off("Network.loadingFailed", networkFailed);
      pipe.off("Page.windowOpen", popup);
      await pipe.send("Network.disable", {}, adapter.session).catch(() => {});
      pipe.off("Page.frameAttached", attached);
      signal.removeEventListener("abort", abort);
      pipe.off("Browser.downloadWillBegin", begin);
      pipe.off("Browser.downloadProgress", progress);
      if (!completed && guid)
        await pipe.send("Browser.cancelDownload", { guid }).catch(() => {});
      await pipe
        .send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: this.browser.downloadDir,
          eventsEnabled: false,
        })
        .catch(() => {});
    }
  }
}
