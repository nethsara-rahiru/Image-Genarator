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
    const result = await this.browser.pipe.send(
      "Runtime.evaluate",
      {
        expression: `(${generationPage.toString()})(${JSON.stringify({ ...request, ...(this.browser.options.test && this.browser.options.automationOrigins ? { origin: this.browser.options.automationOrigins.gemini } : {}) })})`,
        awaitPromise: true,
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
        "Sign in to Gemini using the browser controls, then retry this job. Google may reject automation.",
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
    return value;
  }
  async run(job, { signal, directory, phase, chat }) {
    await this.action({ type: "start", automation: true });
    signal.throwIfAborted();
    const adapter = this.browser.gemini;
    await adapter.open("gemini", job.chatId);
    const login = await adapter.observe({ signal });
    if (login.kind !== "signed_in")
      throw nativeError(
        "GENERATION_LOGIN_REQUIRED",
        "Connect a signed-in Gemini session in the browser, then retry the job. No prompt was submitted.",
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
    const accountKey = before.accountKey,
      baseline = before.responseIds,
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
      { operation: "send", accountKey, prompt: job.submittedPrompt, baseline },
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
    let selected;
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
    await phase("downloading");
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
    const { frameTree } = await pipe.send(
      "Page.getFrameTree",
      {},
      adapter.session,
    );
    let guid, timer, resolve, reject;
    let completed = false;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {});
    const begin = (event) => {
      if (
        event.frameId === frameTree.frame.id &&
        !guid &&
        /^[a-f0-9-]{16,80}$/i.test(event.guid)
      )
        guid = event.guid;
    };
    const progress = (event) => {
      if (event.guid !== guid) return;
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
        completed = true;
        resolve(path.join(directory, guid));
      } else if (event.state === "canceled")
        reject(
          nativeError(
            "GENERATION_DOWNLOAD_INTERRUPTED",
            "Gemini's image download was interrupted. Inspect the chat; the prompt will not be resubmitted.",
          ),
        );
    };
    const abort = () =>
      reject(
        signal.reason ||
          nativeError("GENERATION_CANCELLED", "Generation cancelled."),
      );
    pipe.on("Browser.downloadWillBegin", begin);
    pipe.on("Browser.downloadProgress", progress);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () =>
        reject(
          nativeError(
            "GENERATION_DOWNLOAD_TIMEOUT",
            "The original image download did not complete. Inspect the saved chat before retrying.",
          ),
        ),
      45000,
    );
    try {
      signal.throwIfAborted();
      await pipe.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: directory,
        eventsEnabled: true,
      });
      const result = await this.evaluate(
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
      return await completion;
    } finally {
      clearTimeout(timer);
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
