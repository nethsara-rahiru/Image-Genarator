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
  trace(job, stage, outcome, message, details = {}) {
    this.browser.log?.write(
      outcome === "failed" ? "warn" : "info",
      "browser",
      "AUTOMATION_TRACE",
      message,
      { ...details, jobId: job.id, stage, outcome },
    );
  }
  async pace(job, stage, signal) {
    const delayMs = this.browser.config?.automationStepDelayMs ?? 1000;
    this.trace(
      job,
      stage,
      "waiting",
      "Pausing before the next automation step.",
      { delayMs },
    );
    await pause(delayMs, undefined, { signal });
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
  async waitForDownloadCleanup() {
    await this.downloadCleanup;
    if (this.downloadCleanupError) throw this.downloadCleanupError;
  }
  async waitForPageReady(job, signal) {
    const deadline =
      Date.now() + (this.browser.config?.generationReadyTimeoutMs || 45000);
    let last;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        last = await this.browser.gemini.observe({
          signal,
          timeout: Math.min(1500, deadline - Date.now()),
        });
      } catch (error) {
        if (error.code !== "AUTOMATION_TIMEOUT") throw error;
        last = { kind: "unknown" };
      }
      if (last.kind === "signed_in") {
        try {
          const page = await this.evaluate(
            { operation: "inspect", accountKey: job.accountKey },
            signal,
          );
          if (page.kind === "ready" && page.editorReady) return page;
        } catch (error) {
          if (
            ![
              "GENERATION_LOGIN_REQUIRED",
              "GENERATION_PAGE_CHANGED",
              "AUTOMATION_TIMEOUT",
            ].includes(error.code)
          )
            throw error;
        }
      }
      await pause(200, undefined, { signal });
    }
    if (
      [
        "signed_out",
        "email",
        "password",
        "verification",
        "account_chooser",
      ].includes(last?.kind)
    )
      throw nativeError(
        "GENERATION_LOGIN_REQUIRED",
        "The loaded page requires Google sign-in. Sign in manually in Chrome, then retry. No prompt was submitted.",
      );
    if (["security_check", "blocked"].includes(last?.kind))
      throw nativeError(
        "GENERATION_RESTRICTED",
        "The page reports a security restriction or blocked destination. Inspect Chrome manually. No prompt was submitted.",
      );
    throw nativeError(
      "GENERATION_PAGE_NOT_READY",
      "Gemini did not finish loading its signed-in prompt editor within the readiness timeout. Check the page/network and retry. No prompt was submitted.",
    );
  }
  async waitForStablePage(job, signal, phase) {
    let expectedAccount = job.accountKey;
    while (true) {
      const before = await this.waitForPageReady(
        { ...job, accountKey: expectedAccount },
        signal,
      );
      expectedAccount ||= before.accountKey;
      await phase("settling_page");
      const settleMs = this.browser.options?.test
        ? (this.browser.options.pageSettleMs ?? 5000)
        : 5000;
      await pause(settleMs, undefined, { signal });
      try {
        const after = await this.evaluate(
          { operation: "inspect", accountKey: expectedAccount },
          signal,
        );
        if (
          after.kind === "ready" &&
          after.editorReady &&
          after.documentId === before.documentId &&
          after.chatId === before.chatId
        )
          return after;
      } catch (error) {
        if (
          ![
            "GENERATION_LOGIN_REQUIRED",
            "GENERATION_PAGE_CHANGED",
            "AUTOMATION_TIMEOUT",
          ].includes(error.code)
        )
          throw error;
      }
      await phase("waiting_for_page");
    }
  }
  async uploadReferences(job, directory, signal, accountKey) {
    const references = job.references || [];
    if (!Array.isArray(references) || references.length > 4)
      throw nativeError(
        "GENERATION_REFERENCES",
        "Reference image list is invalid.",
      );
    if (!references.length) return;
    const inputs = path.join(directory, "inputs");
    const inputStat = await fs.lstat(inputs);
    if (!inputStat.isDirectory() || inputStat.isSymbolicLink())
      throw nativeError(
        "GENERATION_REFERENCES",
        "Reference image storage is unsafe.",
      );
    const files = [];
    for (const reference of references) {
      if (
        !/^reference-[1-4]-[a-f0-9]{8}\.(png|jpg|webp)$/.test(
          reference.filename,
        )
      )
        throw nativeError(
          "GENERATION_REFERENCES",
          "Reference image storage is invalid.",
        );
      const file = path.join(inputs, reference.filename);
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw nativeError(
          "GENERATION_REFERENCES",
          "Reference image storage is invalid.",
        );
      if (imageInfo(await fs.readFile(file)).checksum !== reference.checksum)
        throw nativeError(
          "GENERATION_REFERENCES",
          "A reference image changed. No prompt was submitted.",
        );
      files.push(file);
    }
    const pipe = this.browser.pipe,
      session = this.browser.gemini.session;
    this.trace(
      job,
      "upload_discovery",
      "started",
      "Searching the prompt composer for an image input or attachment menu.",
      { fileCount: files.length },
    );
    await pipe.send(
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
      session,
    );
    try {
      let prepared = false;
      let lastDiscovery;
      for (let n = 0; n < 20; n++) {
        lastDiscovery = await this.evaluate(
          { operation: "prepare_attachments", accountKey },
          signal,
        );
        this.trace(
          job,
          "upload_discovery",
          lastDiscovery.ok ? "selected" : "waiting",
          "Upload discovery snapshot; counts and viewport geometry only.",
          { ...lastDiscovery, attempt: n + 1 },
        );
        if (lastDiscovery.reason === "click_required") {
          this.trace(
            job,
            "upload_click",
            "started",
            "About to activate the identified upload control at the recorded viewport rectangle.",
            lastDiscovery,
          );
          let activated;
          try {
            activated = await this.evaluate(
              {
                operation: "activate_upload_control",
                accountKey,
                targetToken: lastDiscovery.targetToken,
                documentId: lastDiscovery.documentId,
              },
              signal,
            );
          } catch (error) {
            this.trace(
              job,
              "upload_click",
              "failed",
              "Upload control activation did not acknowledge; inspect the job error. The click is not blindly retried.",
              lastDiscovery,
            );
            throw error;
          }
          this.trace(
            job,
            "upload_click",
            activated.ok
              ? "selected"
              : activated.reason === "upload_menu_opened"
                ? "dispatched"
                : "changed",
            activated.ok
              ? "An image input appeared before a click was needed."
              : activated.reason === "upload_menu_opened"
                ? "Click dispatched; waiting for the menu or image input to appear."
                : "The target changed before activation; discovery will recheck it.",
            activated,
          );
          lastDiscovery = activated;
          if (activated.reason === "upload_menu_opened")
            await this.pace(job, "upload_click", signal);
        }
        if (lastDiscovery.ok) {
          prepared = true;
          break;
        }
        await pause(500, undefined, { signal });
      }
      if (!prepared) {
        this.trace(
          job,
          "upload_discovery",
          "failed",
          "No unique usable image input appeared before the discovery deadline.",
          lastDiscovery || {},
        );
        throw nativeError(
          "GENERATION_UPLOAD_UNAVAILABLE",
          lastDiscovery?.reason === "ambiguous_inputs"
            ? "Several eligible Gemini image upload inputs remain. No prompt was submitted."
            : "Gemini's image upload input did not appear after checking its attachment menu. No prompt was submitted.",
        );
      }
      const { root } = await pipe.send("DOM.getDocument", {}, session);
      const { nodeId } = await pipe.send(
        "DOM.querySelector",
        {
          nodeId: root.nodeId,
          selector: '[data-local-reference-input="true"]',
        },
        session,
      );
      if (!nodeId) {
        this.trace(
          job,
          "upload_files",
          "failed",
          "The selected image input disappeared before file delivery.",
        );
        throw nativeError(
          "GENERATION_UPLOAD_UNAVAILABLE",
          "Gemini's upload input changed. No prompt was submitted.",
        );
      }
      await this.pace(job, "upload_files", signal);
      this.trace(
        job,
        "upload_files",
        "started",
        "Delivering validated reference files to the selected input.",
        { target: "file_input", fileCount: files.length },
      );
      await pipe.send("DOM.setFileInputFiles", { nodeId, files }, session);
      this.trace(
        job,
        "upload_files",
        "dispatched",
        "Chrome acknowledged file delivery; Gemini attachment confirmation is still required.",
        { fileCount: files.length },
      );
      await this.pace(job, "upload_files", signal);
    } finally {
      await pipe.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
        session,
      );
    }
    this.trace(
      job,
      "attachment_confirmation",
      "started",
      "Waiting for all reference attachments to be confirmed in the composer.",
      { fileCount: files.length },
    );
    const timeoutMs = this.browser.config?.generationUploadTimeoutMs ?? 60000;
    const uploadStarted = Date.now();
    const uploadDeadline = uploadStarted + timeoutMs;
    let lastStatus;
    let lastReported = 0;
    while (Date.now() < uploadDeadline) {
      const status = await this.evaluate(
        {
          operation: "attachments_ready",
          accountKey,
          referenceNames: references.map((reference) => reference.filename),
          referenceChecksums: references.map((reference) => reference.checksum),
        },
        signal,
      );
      const signature = JSON.stringify(status);
      if (signature !== lastStatus || Date.now() - lastReported >= 10000) {
        this.trace(
          job,
          "attachment_confirmation",
          status.ok ? "confirmed" : "waiting",
          "Attachment confirmation snapshot; counts only, no filenames.",
          { ...status, durationMs: Date.now() - uploadStarted },
        );
        lastStatus = signature;
        lastReported = Date.now();
      }
      if (status.ok) {
        this.trace(
          job,
          "attachment_confirmation",
          "confirmed",
          "All expected reference attachments are confirmed.",
          { fileCount: files.length },
        );
        await this.pace(job, "attachment_confirmation", signal);
        return;
      }
      await pause(1000, undefined, { signal });
    }
    this.trace(
      job,
      "attachment_confirmation",
      "failed",
      "Gemini did not confirm every expected attachment within the configured upload wait. Inspect the confirmation counts.",
      { fileCount: files.length },
    );
    throw nativeError(
      "GENERATION_UPLOAD_UNCONFIRMED",
      `Gemini did not confirm all reference attachments within ${Math.round(timeoutMs / 1000)} seconds. Check attachment confirmation counts in Live automation. No prompt was submitted.`,
    );
  }
  async run(job, { signal, directory, phase: persistPhase, chat }) {
    const phase = async (stage, extra) => {
      await persistPhase(stage, extra);
      this.trace(job, stage, "started", "Generation phase entered.");
    };
    await this.waitForDownloadCleanup();
    this.recoveryRequest = job.downloadOnly
      ? job.downloadCheckpoint?.imageKey
        ? { recoverImageKey: job.downloadCheckpoint.imageKey }
        : { recoverPrompt: job.submittedPrompt }
      : {};
    this.trace(
      job,
      "waiting_for_page",
      "started",
      "Starting or reusing the managed browser.",
    );
    await this.action({ type: "start", automation: true });
    signal.throwIfAborted();
    const adapter = this.browser.gemini;
    this.trace(
      job,
      "waiting_for_page",
      "started",
      "Opening Gemini in the managed browser; navigation has not acknowledged yet.",
    );
    await adapter.open("gemini", job.chatId);
    await phase("waiting_for_page");
    let before = await this.waitForStablePage(job, signal, phase);
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
        const newChatDeadline =
          Date.now() + (this.browser.config?.generationReadyTimeoutMs || 45000);
        const newChatAccountKey = before.accountKey;
        while (Date.now() < newChatDeadline) {
          await pause(250, undefined, { signal });
          try {
            before = await this.evaluate(
              { operation: "inspect", accountKey: newChatAccountKey },
              signal,
            );
          } catch (error) {
            if (
              ["GENERATION_LOGIN_REQUIRED", "GENERATION_PAGE_CHANGED"].includes(
                error.code,
              )
            )
              continue;
            throw error;
          }
          if (
            before.kind === "ready" &&
            before.editorReady &&
            !before.chatId &&
            !before.responseIds.length
          )
            break;
        }
        if (
          before.kind === "ready" &&
          before.editorReady &&
          !before.chatId &&
          !before.responseIds.length
        )
          before = await this.waitForStablePage(
            { accountKey: newChatAccountKey },
            signal,
            phase,
          );
        if (
          before.kind !== "ready" ||
          before.chatId ||
          before.responseIds.length
        )
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

      if (job.references?.length) {
        await phase("uploading_assets", { accountKey });
        await this.uploadReferences(job, directory, signal, accountKey);
      }

      await phase("preparing_prompt", { accountKey });
      await this.pace(job, "preparing_prompt", signal);
      const filled = await this.evaluate(
        { operation: "fill_prompt", accountKey, prompt: job.submittedPrompt },
        signal,
      );
      if (!filled.ok)
        throw nativeError(
          "GENERATION_EDITOR",
          "The prompt editor changed. No prompt was submitted.",
        );
      await this.pace(job, "preparing_prompt", signal);
      let ready;
      for (let n = 0; n < 60; n++) {
        ready = await this.evaluate(
          { operation: "inspect", accountKey, baseline, baselineImages },
          signal,
        );
        if (ready.canSend) break;
        await pause(500, undefined, { signal });
      }
      if (!ready?.canSend)
        throw nativeError(
          "GENERATION_SEND_UNAVAILABLE",
          "The Send button was not available. No prompt was submitted.",
        );
      await this.pace(job, "submitting_prompt", signal);
      await phase("submitting_prompt", { submissionPossible: true });
      const submitted = await this.evaluate(
        {
          operation: "send",
          accountKey,
          prompt: job.submittedPrompt,
          baseline,
          referenceNames: (job.references || []).map(
            (reference) => reference.filename,
          ),
          referenceChecksums: (job.references || []).map(
            (reference) => reference.checksum,
          ),
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
      expectedChatId: job.chatId,
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
  async stableDownloadControl(
    { selection, expectedChatId, accountKey, baseline, baselineImages },
    signal,
  ) {
    const original = selection;
    const request = { accountKey, baseline, baselineImages };
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      const state = await this.evaluate(
        { operation: "inspect", ...request },
        signal,
      );
      const current = state.selection;
      const sameImage =
        current &&
        (original.imageKey
          ? current.imageKey === original.imageKey
          : current.imageId === original.imageId);
      if (!sameImage || (expectedChatId && state.chatId !== expectedChatId))
        throw nativeError(
          "GENERATION_DOWNLOAD_CHANGED",
          "The selected image or saved conversation changed. No download click was sent.",
        );
      selection = current;
      const point = await this.evaluate(
        { operation: "download", selection, ...request },
        signal,
      );
      if (point.ok) {
        await this.browser.pipe.send(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: point.x, y: point.y },
          this.browser.gemini.session,
        );
        const next = await this.evaluate(
          { operation: "inspect", ...request },
          signal,
        );
        const sameNext =
          next.selection &&
          (original.imageKey
            ? next.selection.imageKey === original.imageKey
            : next.selection.imageId === original.imageId);
        if (!sameNext || (expectedChatId && next.chatId !== expectedChatId))
          throw nativeError(
            "GENERATION_DOWNLOAD_CHANGED",
            "The selected image or saved conversation changed. No download click was sent.",
          );
        selection = next.selection;
        const checked = await this.evaluate(
          { operation: "download", selection, ...request },
          signal,
        );
        if (
          checked.ok &&
          Math.abs(checked.x - point.x) <= 2 &&
          Math.abs(checked.y - point.y) <= 2
        )
          return checked;
      } else {
        const hover = await this.evaluate(
          { operation: "hover_image", selection, ...request },
          signal,
        );
        if (hover.ok)
          await this.browser.pipe.send(
            "Input.dispatchMouseEvent",
            { type: "mouseMoved", x: hover.x, y: hover.y },
            this.browser.gemini.session,
          );
      }
      await pause(100, undefined, { signal });
    }
    throw nativeError(
      "GENERATION_DOWNLOAD_UNSTABLE",
      "The verified image download control did not settle. Wait for Gemini's layout to finish, then use Download existing image; no prompt or download click was repeated.",
    );
  }
  async download({
    selection,
    expectedChatId,
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
      transferCompleted = false,
      fileObserved = false,
      clickAcknowledged = false;
    const attached = (event) => {
      if (frames.has(event.parentFrameId)) frames.add(event.frameId);
    };
    const pollFile = async () => {
      if (polling || finished) return;
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
        if (!fileObserved) {
          fileObserved = true;
          this.browser.log?.write(
            "info",
            "browser",
            "IMAGE_DOWNLOAD_FILE_OBSERVED",
            "A completed-name file appeared in the job download folder; checking bytes independently of Chrome.",
          );
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
        if (unverifiedFrame)
          throw nativeError(
            "GENERATION_DOWNLOAD_FRAME_UNVERIFIED",
            "A download from an unexpected origin was observed; the file was not attached to this job.",
          );
        if (!clickAcknowledged)
          this.browser.log?.write(
            "info",
            "browser",
            "IMAGE_DOWNLOAD_ACK_PENDING",
            "The image file is complete while Chrome's click acknowledgement is still pending; file handoff will continue.",
          );
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
        if (!completed)
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
      // Frame confirmation is supplementary: never pause the Node file scanner.
      if (event.url) {
        try {
          const url = new URL(event.url);
          const origin =
            (this.browser.options?.test &&
              this.browser.options.automationOrigins?.gemini) ||
            "https://gemini.google.com";
          if (
            url.origin !== origin &&
            !(
              url.protocol === "https:" &&
              /(^|\.)googleusercontent\.com$/.test(url.hostname)
            )
          ) {
            unverifiedFrame = true;
            reject(
              nativeError(
                "GENERATION_DOWNLOAD_FRAME_UNVERIFIED",
                "An unrelated-origin download was rejected.",
              ),
            );
            return;
          }
        } catch {
          unverifiedFrame = true;
          reject(
            nativeError(
              "GENERATION_DOWNLOAD_FRAME_UNVERIFIED",
              "Download origin could not be verified.",
            ),
          );
          return;
        }
      }
      // Google can create its download iframe after the toolbar click.
      pendingGuid = event.guid;
      pipe
        .send("Page.getFrameTree", {}, adapter.session)
        .then(({ frameTree }) => {
          if (finished) return;
          collect(frameTree);
          if (frames.has(event.frameId)) accept(event);
          else
            this.browser.log?.write(
              "info",
              "browser",
              "IMAGE_DOWNLOAD_FRAME_PENDING",
              "The frame was not in the current tree; the isolated file monitor remains active after the verified image click.",
            );
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
      const result = await this.stableDownloadControl(
        { selection, expectedChatId, accountKey, baseline, baselineImages },
        signal,
      );
      clicked = true;
      // Queue down/up in order without making the up event wait for a renderer ACK.
      const press = pipe.send(
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
      const release = pipe.send(
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
        "IMAGE_DOWNLOAD_CLICK_SENT",
        "Verified download input was queued once; completed files are tracked independently of Chrome acknowledgements.",
      );
      Promise.all([press, release])
        .then(() => {
          clickAcknowledged = true;
          this.browser.log?.write(
            "info",
            "browser",
            "IMAGE_DOWNLOAD_CLICKED",
            "Chrome acknowledged the original-image download click.",
          );
        })
        .catch(() => {
          if (!finished)
            this.browser.log?.write(
              "warn",
              "browser",
              "IMAGE_DOWNLOAD_ACK_DELAYED",
              "Chrome did not acknowledge the input command; the independent file monitor remains active. No click will be repeated.",
            );
        });
      return await completion;
    } finally {
      finished = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      pipe.off("Network.requestWillBeSent", networkRequest);
      pipe.off("Network.loadingFinished", networkFinished);
      pipe.off("Network.loadingFailed", networkFailed);
      pipe.off("Page.windowOpen", popup);
      pipe.off("Page.frameAttached", attached);
      signal.removeEventListener("abort", abort);
      pipe.off("Browser.downloadWillBegin", begin);
      pipe.off("Browser.downloadProgress", progress);
      this.downloadCleanupPending = true;
      this.browser.log?.write(
        "info",
        "browser",
        "IMAGE_DOWNLOAD_CLEANUP_PENDING",
        "Browser download cleanup is pending; a verified file can be published before it finishes.",
      );
      this.downloadCleanup = (async () => {
        if (!completed && guid)
          await pipe.send("Browser.cancelDownload", { guid }).catch(() => {});
        try {
          await pipe.send("Browser.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: this.browser.downloadDir,
            eventsEnabled: false,
          });
        } catch {
          this.browser.log?.write(
            "warn",
            "browser",
            "IMAGE_DOWNLOAD_CLEANUP_FAILED",
            "Browser cleanup failed; resetting the managed browser before another job. Saved output is retained.",
          );
          if (this.browser.stop) await this.browser.stop();
          else
            throw nativeError(
              "GENERATION_BROWSER_RESET_REQUIRED",
              "Browser cleanup failed; restart the app before another generation.",
            );
          return;
        }
        try {
          await pipe.send("Network.disable", {}, adapter.session);
        } catch {
          this.browser.log?.write(
            "warn",
            "browser",
            "IMAGE_DOWNLOAD_TELEMETRY_DELAYED",
            "Telemetry cleanup was not acknowledged; the download destination was restored and saved output remains available.",
          );
        }
      })()
        .catch(() => {
          this.downloadCleanupError = nativeError(
            "GENERATION_BROWSER_RESET_REQUIRED",
            "Browser cleanup could not finish. Restart the app before generating again; completed images remain available.",
          );
          this.browser.log?.write(
            "warn",
            "browser",
            "IMAGE_DOWNLOAD_RESET_FAILED",
            "Managed browser reset failed after download cleanup; inspect the browser before continuing.",
          );
        })
        .finally(() => {
          this.downloadCleanupPending = false;
          this.browser.log?.write(
            "info",
            "browser",
            "IMAGE_DOWNLOAD_CLEANUP_FINISHED",
            "Browser download cleanup finished.",
          );
        });
    }
  }
}
