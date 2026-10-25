import fs from "node:fs/promises";
import path from "node:path";
import { remoteRequest } from "./transport.js";
import { readDownload, imageInfo, multipartImage } from "./files.js";
export class LocalAgent {
  constructor(
    settings,
    save,
    broker,
    notify,
    { request = remoteRequest } = {},
  ) {
    this.settings = settings;
    this.save = save;
    this.broker = broker;
    this.notify = notify;
    this.request = request;
    this.run = null;
    this.stopped = false;
    this.busy = false;
    this.lastSuccess = 0;
    this.controlBusy = false;
  }
  async api(p, body, extra = {}) {
    return this.request(this.settings, `/api/companion${p}`, {
      ...(body !== undefined ? { method: "POST", body } : {}),
      ...extra,
    });
  }
  async start() {
    this.timer = setInterval(() => this.pulse(), 3000);
    this.timer.unref();
    await this.pulse();
  }
  async pulse() {
    if (this.busy || this.stopped || !this.settings.token) return;
    this.busy = true;
    try {
      const response = await this.api("/heartbeat", {
        browsers: this.broker.online(),
        ...(this.run && !this.run.completed
          ? {
              run: {
                jobId: this.run.id,
                runId: this.run.runId,
                fence: this.run.fence,
              },
            }
          : {}),
      });
      this.lastSuccess = Date.now();
      if (
        this.run &&
        !this.run.completed &&
        (response.data.cancelRequested ||
          !this.broker.online().some((b) => b.id === this.run.browserId))
      ) {
        this.broker.cancel(
          this.run.browserId,
          response.data.cancelRequested ? "CANCELLED" : "LOCAL_DISCONNECTED",
        );
      }
      this.state = (await this.api("/state")).data;
      this.notify("state", this.summary());
      if (!this.controlBusy) {
        this.controlBusy = true;
        this.controls().finally(() => {
          this.controlBusy = false;
        });
      }
      if (!this.run && this.broker.available().length) {
        const result = await this.api("/claim", {});
        if (result.data.job) {
          this.run = result.data.job;
          this.settings.pendingRun = {
            id: this.run.id,
            runId: this.run.runId,
            fence: this.run.fence,
          };
          await this.save();
          this.execution = this.execute(this.run).catch(() => {});
        } else this.waitReason = result.data.reason;
      }
    } catch (e) {
      this.notify("error", { message: e.message });
      if (this.run)
        this.broker.cancel(this.run.browserId, "LOCAL_DISCONNECTED");
    } finally {
      this.busy = false;
    }
  }
  summary() {
    return {
      paired: Boolean(this.settings.token),
      origin: this.settings.origin,
      device: this.state?.device,
      accounts: this.state?.accounts || [],
      executionMode: this.state?.executionMode,
      browsers: this.settings.browsers.map((b) => ({
        id: b.id,
        label: b.label,
        online: this.broker.online().some((v) => v.id === b.id),
      })),
      activeJob: this.run
        ? { id: this.run.id, state: this.run.state || "running" }
        : null,
      waitReason: this.waitReason,
      downloadRoot: this.settings.downloadRoot,
      pendingRun: this.settings.pendingRun,
    };
  }
  async controls() {
    try {
      const d = await this.api("/commands/claim", {
        available: this.broker.available(),
      });
      const c = d.data.command;
      if (!c) return;
      let result;
      try {
        result = await this.broker.run(
          c.browserId,
          { kind: "control", command: c },
          20000,
        );
      } catch (e) {
        result = { error: e.code || "BROWSER_ACTION_FAILED" };
      }
      await this.api(`/commands/${c.id}/result`, result);
    } catch (e) {
      this.notify("error", { message: e.message });
    }
  }
  async execute(job) {
    try {
      const locators = (
        await this.api(
          `/jobs/${job.id}/locators?runId=${job.runId}&fence=${job.fence}`,
        )
      ).data.items;
      const result = await this.broker.run(
        job.browserId,
        { kind: "job", job, locators },
        job.timeoutMs + 120000,
      );
      if (!result?.uploaded)
        throw Object.assign(new Error("Original output not uploaded"), {
          code: "DOWNLOAD_FAILED",
        });
      this.notify("completed", { jobId: job.id, outputId: result.outputId });
    } catch (e) {
      if (job.completed) {
        this.notify("completed", { jobId: job.id });
        return;
      }
      const code = [
        "NEEDS_LOGIN",
        "NO_IMAGE",
        "RESTRICTED",
        "CANCELLED",
        "LOCAL_DISCONNECTED",
        "DOWNLOAD_FAILED",
        "UPLOAD_FAILED",
        "LOST_TASK_CONTEXT",
      ].includes(e.code)
        ? e.code
        : "AUTOMATION";
      try {
        await this.api(`/jobs/${job.id}/fail`, {
          runId: job.runId,
          fence: job.fence,
          code,
          message: code,
        });
        this.settings.pendingRun = null;
        await this.save();
      } catch {
        this.notify("error", {
          message:
            "Run state is uncertain. Keep the queue paused and inspect Jobs on the VPS.",
        });
      }
    } finally {
      if (!this.settings.pendingRun || this.settings.pendingRun.id === job.id) {
        if (this.run?.completed) {
          this.settings.pendingRun = null;
          await this.save();
        }
      }
      this.run = null;
      this.notify("state", this.summary());
    }
  }
  ensure(browserId, taskId) {
    const task = this.broker.task(browserId, taskId);
    if (
      task.task.kind !== "job" ||
      !this.run ||
      task.task.job.runId !== this.run.runId
    )
      throw new Error("Browser is not assigned to this job");
    if (Date.now() - this.lastSuccess > 12000)
      throw new Error("VPS heartbeat is stale");
    return this.run;
  }
  async action(browserId, d) {
    const job = this.ensure(browserId, d.taskId);
    const auth = { runId: job.runId, fence: job.fence };
    if (d.action === "asset") {
      if (!job.assets.some((a) => a.id === d.assetId))
        throw new Error("Asset is outside this job");
      const result = await this.api(
        `/jobs/${job.id}/assets/${d.assetId}?runId=${job.runId}&fence=${job.fence}`,
      );
      const a = job.assets.find((a) => a.id === d.assetId);
      return { ...a, base64: result.buffer.toString("base64") };
    }
    if (d.action === "progress") {
      if (
        ![
          "uploading_assets",
          "submitting_prompt",
          "generating",
          "downloading",
        ].includes(d.state)
      )
        throw new Error("Invalid job stage");
      await this.api(`/jobs/${job.id}/progress`, {
        ...auth,
        state: d.state,
        ...(d.chatUrl ? { chatUrl: d.chatUrl } : {}),
      });
      job.state = d.state;
      this.notify("state", this.summary());
      return { ok: true };
    }
    if (d.action === "permit") {
      const started = Date.now();
      const result = await this.api(`/jobs/${job.id}/permit`, auth);
      const remaining = result.data.permitMs - (Date.now() - started) - 500;
      if (remaining <= 0) throw new Error("Submission permit expired");
      return { expiresAt: Date.now() + remaining };
    }
    if (d.action === "recover")
      return (
        await this.api(`/jobs/${job.id}/recover`, {
          ...auth,
          action: d.semantic,
          candidates: d.candidates,
        })
      ).data;
    if (d.action === "locator") {
      await this.api(`/jobs/${job.id}/locator`, {
        ...auth,
        action: d.semantic,
        value: d.value,
        verified: d.verified,
      });
      return { ok: true };
    }
    if (d.action === "download") {
      const buffer = await readDownload(
        this.settings.downloadRoot,
        d.filename,
        job.runId,
      );
      let info;
      try {
        info = imageInfo(buffer);
      } catch {
        return { valid: false };
      }
      return { valid: true, ...info };
    }
    if (d.action === "output") {
      const buffer = await readDownload(
        this.settings.downloadRoot,
        d.filename,
        job.runId,
      );
      imageInfo(buffer);
      const multipart = multipartImage(buffer, job);
      const response = await this.api(
        `/jobs/${job.id}/output`,
        multipart.body,
        { headers: multipart.headers },
      );
      job.completed = true;
      this.settings.pendingRun = null;
      await this.save();
      return { uploaded: true, outputId: response.data.outputId };
    }
    throw new Error("Unknown browser action");
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.broker.close();
    if (this.execution)
      await Promise.race([
        this.execution,
        new Promise((r) => {
          const timer = setTimeout(r, 10000);
          timer.unref();
        }),
      ]);
  }
}
