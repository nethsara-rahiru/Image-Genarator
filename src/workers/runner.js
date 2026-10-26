import path from "node:path";
import { expireRuns } from "../services/local/jobs.js";
import { captureMonitor } from "../services/monitorService.js";
import fs from "node:fs/promises";
import {
  GenerationJob,
  GoogleAccount,
  Asset,
  Setting,
  GeneratedOutput,
  AutomationEvent,
  GeminiChat,
} from "../models/index.js";
import {
  LockManager,
  claim,
  recover,
  transition,
  activeStates,
} from "../services/jobQueue.js";
import { GeminiAdapter } from "../services/geminiAdapter.js";
import { ElementRegistry } from "../services/elementRegistry.js";
import { GroqRecoveryAgent } from "../services/groqRecoveryAgent.js";
import { saveOutput, deleteOutput } from "../services/outputManager.js";
import { persistChat } from "../services/chatManager.js";
import { safePath } from "../utils/files.js";
import { AppError } from "../utils/errors.js";
import { emit } from "../services/eventService.js";
export class Worker {
  constructor(config, browsers) {
    this.config = config;
    this.browsers = browsers;
    this.lock = new LockManager(undefined, config.LEASE_MS);
    this.stopped = false;
    this.session = null;
    this.current = null;
    this.heartbeat = null;
    this.busy = false;
  }
  async start() {
    if (this.config.EXECUTION_MODE === "local") {
      await emit(
        "worker.local_mode",
        "Local companions execute generation jobs; VPS retains storage and housekeeping",
      );
      return;
    }
    if (!(await this.lock.acquire("worker")))
      throw new AppError(
        "WORKER_BUSY",
        "Another worker holds the global lease",
        409,
      );
    await recover();
    this.heartbeat = setInterval(
      () => this.pulse(),
      Math.floor(this.config.LEASE_MS / 3),
    );
    this.heartbeat.unref();
    await emit("worker.started", "Global worker acquired exclusive lease");
  }
  async pulse() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const l = await this.lock.heartbeat("worker");
      if (this.current) {
        const j = await GenerationJob.findOneAndUpdate(
          {
            _id: this.current._id,
            owner: this.lock.owner,
            fence: this.current.fence,
            state: { $in: activeStates },
          },
          { $set: { heartbeat: new Date(), leaseUntil: l.expiresAt } },
          { new: true },
        );
        if (!j || j.cancelRequested) {
          this.abortReason = new AppError(
            "CANCELLED",
            "Job cancelled by administrator",
          );
          await this.session?.close();
        }
      }
    } catch {
      this.abortReason = new AppError(
        "LEASE_LOST",
        "Worker lost database lease",
      );
      this.stopped = true;
      await this.session?.close();
    } finally {
      this.busy = false;
    }
  }
  async ensure() {
    if (this.abortReason) throw this.abortReason;
    await this.lock.heartbeat("worker");
    const job = await GenerationJob.findById(this.current._id);
    if (job.cancelRequested)
      throw new AppError("CANCELLED", "Job cancelled by administrator");
  }
  async tick() {
    if (this.config.EXECUTION_MODE === "local") {
      await expireRuns(this.config);
      return false;
    }
    const first = await GenerationJob.findOne({ state: "queued" }).sort({
      enqueuedAt: 1,
      _id: 1,
    });
    if (first?.executionMode === "local") return false;
    const job = await claim(this.lock);
    if (!job) return false;
    this.current = job;
    this.abortReason = null;
    let output;
    let chat;
    try {
      const account = await GoogleAccount.findById(job.accountId);
      if (!account || account.disabled)
        throw new AppError("ACCOUNT", "Account disabled or deleted");
      if (
        [
          "disconnected",
          "expired",
          "login_required",
          "authenticating",
        ].includes(account.state)
      )
        throw new AppError("NEEDS_LOGIN", "Connect and verify account first");
      this.session = await this.browsers.open(job.accountId);
      const settings = (await Setting.findById("global")) || {};
      const adapter = new GeminiAdapter(
        this.session.page,
        new ElementRegistry(
          this.session.page,
          new GroqRecoveryAgent(this.config, settings),
        ),
        settings.generationTimeoutMs || this.config.GENERATION_TIMEOUT_MS,
      );
      if (job.chatId) {
        const saved = await GeminiChat.findOne({
          _id: job.chatId,
          accountId: job.accountId,
        });
        chat =
          saved?.status === "pending"
            ? await adapter.createChat(job.accountId)
            : await adapter.openChat(job.accountId, job.chatId);
        if (saved?.status === "pending") await saved.deleteOne();
      } else chat = await adapter.createChat(job.accountId);
      job.chatId = chat._id;
      await GenerationJob.updateOne(
        { _id: job._id, owner: job.owner, fence: job.fence },
        { $set: { chatId: chat._id } },
      );
      const assets = await Asset.find({ _id: { $in: job.assetIds } });
      if (assets.length !== job.assetIds.length)
        throw new AppError(
          "ASSET_MISSING",
          "Uploaded asset is no longer available",
        );
      await this.ensure();
      await transition(job, "uploading_assets", 15);
      await adapter.uploadAssets(
        assets.map((a) =>
          safePath(path.join(this.config.DATA_DIR, "uploads"), a.filename),
        ),
      );
      await this.ensure();
      await transition(job, "submitting_prompt", 30);
      await adapter.submitPrompt(job.prompt, async () => {
        await this.ensure();
        job.submissionStartedAt = new Date();
        await transition(job, "submitting_prompt", 35, {
          submissionStartedAt: job.submissionStartedAt,
        });
      });
      job.submittedAt = new Date();
      await transition(job, "generating", 45, { submittedAt: job.submittedAt });
      await this.session.page.waitForURL(
        /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]+$/,
        { timeout: 20000 },
      );
      await persistChat(chat, this.session.page);
      const response = await adapter.waitForGeneration();
      await persistChat(chat, this.session.page);
      await this.ensure();
      await transition(job, "downloading", 85);
      const buffer = await adapter.downloadImage(response);
      await captureMonitor(
        this.session,
        response,
        job,
        this.config,
        this.lock,
      ).catch(() => false);
      await this.ensure();
      output = await saveOutput(buffer, job, assets, this.config);
      await this.ensure();
      await transition(job, "completed", 100, {
        outputId: output._id,
        finishedAt: new Date(),
      });
    } catch (error) {
      const e = this.abortReason || error;
      if (chat && this.session)
        await persistChat(chat, this.session.page).catch(() => {});
      const persisted = await GeneratedOutput.findOne({ jobId: job._id }).catch(
        () => null,
      );
      let state = persisted
        ? "completed"
        : e.code === "CANCELLED"
          ? job.submissionStartedAt
            ? "needs_review"
            : "cancelled"
          : e.code === "NEEDS_LOGIN"
            ? "needs_login"
            : job.submissionStartedAt &&
                !["NO_IMAGE", "RESTRICTED"].includes(e.code)
              ? "needs_review"
              : "failed";
      if (e.code === "NEEDS_LOGIN")
        await GoogleAccount.findByIdAndUpdate(job.accountId, {
          state: "login_required",
        }).catch(() => {});
      await transition(job, state, state === "completed" ? 100 : 0, {
        finishedAt: new Date(),
        ...(persisted
          ? { outputId: persisted._id }
          : {
              error: {
                code: e.code || "AUTOMATION",
                message: e.status
                  ? e.message
                  : "Browser operation failed; inspect events and conversation",
              },
            }),
      }).catch(() => {});
    } finally {
      await this.session?.close().catch(() => {});
      this.session = null;
      this.current = null;
    }
    return true;
  }
  async retention() {
    const settings = await Setting.findById("global");
    const cutoff = new Date(
      Date.now() - (settings?.retentionDays || 30) * 86400000,
    );
    for (const o of await GeneratedOutput.find({
      createdAt: { $lt: cutoff },
    }).limit(100))
      await deleteOutput(o, this.config);
    for (const a of await Asset.find({ createdAt: { $lt: cutoff } }).limit(
      100,
    )) {
      if (
        await GenerationJob.exists({
          assetIds: a._id,
          state: { $in: ["queued", ...activeStates] },
        })
      )
        continue;
      await fs.rm(
        safePath(path.join(this.config.DATA_DIR, "uploads"), a.filename),
        { force: true },
      );
      await a.deleteOne();
    }
    await AutomationEvent.deleteMany({ createdAt: { $lt: cutoff } });
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.abortReason = new AppError("SHUTDOWN", "Worker stopping");
    await this.session?.close().catch(() => {});
    await this.browsers.close(); // Retain lease until active job has unwound; process exit then OS lock releases.
    if (!this.current) await this.lock.release("worker");
  }
}
