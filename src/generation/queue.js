import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { nativeError } from "../native/common.js";
import { actionError } from "../actionErrors.js";
const finalStates = new Set([
  "completed",
  "failed",
  "needs_login",
  "needs_review",
  "cancelled",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class GenerationQueue {
  constructor(config, runner, log) {
    this.config = config;
    this.runner = runner;
    this.log = log;
    this.dir = path.join(config.data, "generation");
    this.file = path.join(this.dir, "queue.json");
    this.outputs = path.join(this.dir, "outputs");
    this.data = { jobs: [], chats: [] };
    this.writes = Promise.resolve();
    this.mutations = Promise.resolve();
    this.version = 0;
  }
  get busy() {
    return !!this.active;
  }
  async init() {
    await fs.mkdir(this.outputs, { recursive: true, mode: 0o700 });
    this.release = await lockfile.lock(this.dir, {
      stale: 15000,
      update: 3000,
      retries: 0,
      onCompromised: () => {
        this.lost = true;
        this.stopping = true;
        this.controller?.abort(
          nativeError(
            "GENERATION_LEASE_LOST",
            "Generation ownership was lost. Inspect the chat before retrying.",
          ),
        );
      },
    });
    try {
      try {
        const stat = await fs.stat(this.file);
        if (stat.size > 20 * 1024 * 1024)
          throw Error("Generation journal too large");
        this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
        if (!Array.isArray(this.data.jobs) || !Array.isArray(this.data.chats))
          throw Error("Invalid generation journal");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const job of this.data.jobs) {
        if (!uuid.test(job.id)) throw Error("Invalid generation journal");
        if (!finalStates.has(job.state) && job.state !== "queued") {
          job.state = job.submissionPossible ? "needs_review" : "failed";
          job.error = {
            code: "GENERATION_RESTARTED",
            message:
              "The app restarted during this job. Inspect the saved chat before retrying.",
          };
        }
      }
      await this.persist();
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  async persist() {
    if (this.lost)
      throw nativeError(
        "GENERATION_LEASE_LOST",
        "Generation storage ownership was lost.",
      );
    const value = JSON.stringify(this.data);
    if (Buffer.byteLength(value) > 20 * 1024 * 1024)
      throw nativeError(
        "GENERATION_STORAGE_FULL",
        "Generation history is full. Remove older local jobs/outputs.",
      );
    const temp = this.file + "." + randomUUID() + ".tmp";
    const result = this.writes.then(async () => {
      await fs.writeFile(temp, value, { mode: 0o600, flag: "wx", flush: true });
      await fs.rename(temp, this.file);
      if (process.platform !== "win32") {
        const directory = await fs.open(this.dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.version++;
    });
    this.writes = result.catch(() => {});
    return result;
  }
  publicJob(job) {
    const {
      accountKey,
      idempotencyKey,
      submittedPrompt,
      downloadCheckpoint,
      ...publicJob
    } = job;
    return {
      ...publicJob,
      canRecoverDownload:
        finalStates.has(job.state) &&
        job.state !== "completed" &&
        !!job.submissionPossible &&
        !!job.chatId &&
        !!accountKey &&
        !!(
          downloadCheckpoint ||
          /^GENERATION_DOWNLOAD_|^GENERATION_INVALID_DOWNLOAD$|^INVALID_IMAGE$/.test(
            job.error?.code || "",
          )
        ),
      queuePosition:
        job.state === "queued"
          ? this.data.jobs.filter(
              (e) => e.state === "queued" && e.sequence <= job.sequence,
            ).length
          : null,
    };
  }
  snapshot() {
    return {
      version: this.version,
      busy: this.busy,
      activeJobId: this.active?.id || null,
      jobs: [...this.data.jobs]
        .reverse()
        .slice(0, 100)
        .map((j) => {
          const value = this.publicJob(j);
          delete value.prompt;
          return { ...value, promptPreview: j.prompt.slice(0, 160) };
        }),
      chats: this.data.chats.map(({ accountKey, ...chat }) => ({ ...chat })),
    };
  }
  get(id) {
    const job = this.data.jobs.find((j) => j.id === id);
    if (!job)
      throw nativeError("GENERATION_NOT_FOUND", "Generation job not found.");
    return job;
  }
  mutate(operation) {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }
  create(input) {
    return this.mutate(() => this.createJob(input));
  }
  cancel(id) {
    return this.mutate(() => this.cancelJob(id));
  }
  retry(id) {
    return this.mutate(() => this.retryJob(id));
  }
  recover(id) {
    return this.mutate(() => this.recoverDownload(id));
  }
  remove(id) {
    return this.mutate(() => this.removeJob(id));
  }
  renameChat(id, title) {
    return this.mutate(() => this.renameSavedChat(id, title));
  }
  async createJob({ prompt, chatId = null, idempotencyKey } = {}) {
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > 8000 ||
      (chatId !== null &&
        (typeof chatId !== "string" ||
          !/^[A-Za-z0-9_-]{4,160}$/.test(chatId))) ||
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)
    )
      throw nativeError(
        "GENERATION_INPUT",
        "Enter a prompt (up to 8000 characters), a valid chat selection and an idempotency key.",
      );
    const prior = this.data.jobs.find(
      (j) => j.idempotencyKey === idempotencyKey,
    );
    if (prior) {
      if (prior.prompt !== prompt.trim() || prior.requestedChatId !== chatId)
        throw nativeError(
          "GENERATION_CONFLICT",
          "This request key was already used for a different prompt/chat.",
        );
      return this.publicJob(prior);
    }
    if (
      this.data.jobs.filter((j) => !finalStates.has(j.state)).length >= 50 ||
      this.data.jobs.length >= 500
    )
      throw nativeError(
        "GENERATION_QUEUE_FULL",
        "Queue/history limit reached. Remove older jobs before submitting more.",
      );
    const chat = chatId ? this.data.chats.find((c) => c.id === chatId) : null;
    if (chatId && !chat)
      throw nativeError(
        "GENERATION_CHAT_NOT_FOUND",
        "Choose a chat from this workspace or create a new chat.",
      );
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      idempotencyKey,
      sequence: Math.max(0, ...this.data.jobs.map((j) => j.sequence)) + 1,
      prompt: prompt.trim(),
      submittedPrompt:
        "Create an image based on this description:\n\n" + prompt.trim(),
      requestedChatId: chatId,
      chatId,
      chatUrl: chat?.url || null,
      accountKey: chat?.accountKey || null,
      state: "queued",
      progress: 0,
      submissionPossible: false,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.jobs.push(job);
    try {
      if (Buffer.byteLength(JSON.stringify(this.data)) > 19 * 1024 * 1024)
        throw nativeError(
          "GENERATION_STORAGE_FULL",
          "Generation history is full. Remove older jobs before adding more.",
        );
      await this.persist();
    } catch (error) {
      this.data.jobs.splice(this.data.jobs.indexOf(job), 1);
      throw error;
    }
    this.start();
    return this.publicJob(job);
  }
  start() {
    if (!this.stopping && !this.pumping) {
      this.pumping = true;
      this.task = Promise.resolve()
        .then(() => this.pump())
        .finally(() => {
          this.pumping = false;
          if (
            !this.stopping &&
            this.data.jobs.some((j) => j.state === "queued")
          )
            this.start();
        });
      this.task.catch(() => {});
    }
  }
  async pump() {
    while (!this.stopping) {
      const job = this.data.jobs
        .filter((j) => j.state === "queued")
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!job) break;
      this.active = job;
      this.controller = new AbortController();
      const controller = this.controller;
      const signal = controller.signal;
      const timeout = setTimeout(
        () =>
          controller.abort(
            nativeError(
              "GENERATION_TIMEOUT",
              "Image generation timed out. Inspect the saved chat; the prompt will not be repeated automatically.",
            ),
          ),
        this.config.generationTimeoutMs || 180000,
      );
      const phase = async (state, extra = {}) => {
        signal.throwIfAborted();
        Object.assign(job, extra, {
          state,
          updatedAt: new Date().toISOString(),
          progress:
            {
              running: 10,
              preparing_prompt: 25,
              submitting_prompt: 40,
              generating: 60,
              downloading: 85,
            }[state] || 0,
        });
        await this.persist();
        this.log?.write(
          "info",
          "browser",
          "GENERATION_STATE",
          "Generation job state: " + state + ".",
          { actionId: job.id },
        );
      };
      try {
        job.attempts++;
        job.startedAt = new Date().toISOString();
        await phase("running");
        const directory = path.join(this.outputs, job.id);
        const output = await this.runner.run(job, {
          signal,
          directory,
          phase,
          chat: async (id, url, accountKey) => {
            if (job.chatId === id && job.chatUrl === url) return;
            job.chatId = id;
            job.chatUrl = url;
            job.accountKey = accountKey;
            if (!this.data.chats.some((c) => c.id === id))
              this.data.chats.push({
                id,
                url,
                accountKey,
                title: job.prompt.slice(0, 80),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            await this.persist();
          },
        });
        signal.throwIfAborted();
        if (!job.chatId || !job.chatUrl)
          throw nativeError(
            "GENERATION_CHAT_UNVERIFIED",
            "The actual Gemini conversation ID could not be verified.",
          );
        const completedAt = new Date().toISOString();
        const metadata = {
          jobId: job.id,
          chatId: job.chatId,
          chatUrl: job.chatUrl,
          accountRef: job.accountKey,
          prompt: job.prompt,
          submittedPrompt: job.submittedPrompt,
          inputAssetNames: [],
          outputFilename: output.filename,
          ...output,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt,
          selectionRule:
            "First valid non-historical image in the latest new model response; original website download.",
        };
        await fs.writeFile(
          path.join(directory, "metadata.json"),
          JSON.stringify(metadata, null, 2),
          { mode: 0o600 },
        );
        Object.assign(job, {
          state: "completed",
          progress: 100,
          output,
          completedAt,
          error: null,
          updatedAt: completedAt,
        });
        const existing = this.data.chats.find((c) => c.id === job.chatId);
        if (existing) {
          existing.updatedAt = completedAt;
        } else
          this.data.chats.push({
            id: job.chatId,
            url: job.chatUrl,
            title: job.prompt.slice(0, 80),
            accountKey: job.accountKey,
            createdAt: completedAt,
            updatedAt: completedAt,
          });
      } catch (error) {
        const diagnosed = actionError(signal.aborted ? signal.reason : error);
        const cancelled =
          signal.aborted && signal.reason?.code === "GENERATION_CANCELLED";
        job.state = cancelled
          ? "cancelled"
          : diagnosed.code === "GENERATION_LOGIN_REQUIRED"
            ? "needs_login"
            : job.submissionPossible && diagnosed.code !== "GENERATION_NO_IMAGE"
              ? "needs_review"
              : "failed";
        job.error = diagnosed;
        job.updatedAt = new Date().toISOString();
        this.log?.write(
          "warn",
          "browser",
          "GENERATION_STOPPED",
          "Generation stopped: " + diagnosed.code + ".",
          { actionId: job.id },
        );
      } finally {
        clearTimeout(timeout);
        this.active = null;
        this.controller = null;
        if (!this.lost) await this.persist();
      }
    }
  }
  async cancelJob(id) {
    const job = this.get(id);
    if (job.state === "queued") {
      job.state = "cancelled";
      await this.persist();
    } else if (this.active?.id === id)
      this.controller.abort(
        nativeError(
          "GENERATION_CANCELLED",
          "Generation cancelled. Any already-submitted prompt remains in its Gemini chat.",
        ),
      );
    return this.publicJob(job);
  }
  async retryJob(id) {
    const job = this.get(id);
    if (
      !finalStates.has(job.state) ||
      job.submissionPossible ||
      job.state === "completed"
    )
      throw nativeError(
        "GENERATION_REVIEW_REQUIRED",
        "This prompt may already have been submitted. Inspect its chat; automatic retry is disabled.",
      );
    job.state = "queued";
    job.sequence = Math.max(...this.data.jobs.map((j) => j.sequence)) + 1;
    job.error = null;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    this.start();
    return this.publicJob(job);
  }
  async recoverDownload(id) {
    const job = this.get(id);
    if (
      !finalStates.has(job.state) ||
      job.state === "completed" ||
      !job.submissionPossible ||
      !job.chatId ||
      !job.accountKey ||
      !(
        job.downloadCheckpoint ||
        /^GENERATION_DOWNLOAD_|^GENERATION_INVALID_DOWNLOAD$|^INVALID_IMAGE$/.test(
          job.error?.code || "",
        )
      )
    )
      throw nativeError(
        "GENERATION_RECOVERY_UNAVAILABLE",
        "This job has no verified download-stage response. Inspect its saved chat manually; no prompt will be resubmitted.",
      );
    job.downloadOnly = true;
    job.state = "queued";
    job.sequence = Math.max(...this.data.jobs.map((j) => j.sequence)) + 1;
    job.error = null;
    job.updatedAt = new Date().toISOString();
    await this.persist();
    this.start();
    return this.publicJob(job);
  }
  async removeJob(id) {
    const job = this.get(id);
    if (!finalStates.has(job.state) || this.active?.id === id)
      throw nativeError(
        "GENERATION_BUSY",
        "Cancel the job before removing it.",
      );
    await fs.rm(path.join(this.outputs, job.id), {
      recursive: true,
      force: true,
    });
    this.data.jobs.splice(this.data.jobs.indexOf(job), 1);
    await this.persist();
  }
  async renameSavedChat(id, title) {
    const chat = this.data.chats.find((c) => c.id === id);
    if (
      !chat ||
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 100
    )
      throw nativeError(
        "GENERATION_CHAT_NOT_FOUND",
        "Choose a saved chat and a title of 1–100 characters.",
      );
    chat.title = title.trim();
    await this.persist();
  }
  async outputFile(id, metadata = false) {
    const job = this.get(id);
    if (
      job.state !== "completed" ||
      !/^image\.(png|jpg|webp)$/.test(job.output?.filename || "") ||
      !uuid.test(id)
    )
      throw nativeError("GENERATION_NOT_FOUND", "Completed image not found.");
    const file = path.join(
      this.outputs,
      id,
      metadata ? "metadata.json" : job.output.filename,
    );
    const stat = await fs.lstat(file),
      resolved = await fs.realpath(file),
      root = await fs.realpath(this.outputs);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !resolved.startsWith(root + path.sep)
    )
      throw nativeError("GENERATION_NOT_FOUND", "Completed image not found.");
    return { path: file, job: this.publicJob(job) };
  }

  async close() {
    this.stopping = true;
    this.controller?.abort(
      nativeError(
        "GENERATION_SHUTDOWN",
        "The app is stopping. Inspect any submitted prompt before retrying.",
      ),
    );
    await this.mutations;
    await this.task?.catch(() => {});
    await this.writes;
    await this.release?.().catch(() => {});
  }
}
