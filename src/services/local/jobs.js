import crypto from "node:crypto";
import {
  GenerationJob,
  GoogleAccount,
  GeminiChat,
  Asset,
  GeneratedOutput,
  Lease,
  Setting,
} from "../../models/index.js";
import { LockManager, activeStates, transition } from "../jobQueue.js";
import { AppError } from "../../utils/errors.js";
import { emit } from "../eventService.js";
import { chatUrl } from "../../utils/files.js";
export function locksFor(job, ttl) {
  const locks = new LockManager(job.owner, ttl);
  locks.held.set("worker", job.fence);
  locks.held.set(`profile:${job.accountId}`, job.profileFence);
  return locks;
}
export async function releaseRun(job, config, { clearBarrier = false } = {}) {
  if (clearBarrier)
    await Lease.updateOne(
      {
        _id: "worker",
        owner: job.owner,
        fence: job.fence,
        blockedJobId: job._id,
      },
      { $unset: { blockedJobId: 1 } },
    );
  const locks = locksFor(job, config.LEASE_MS);
  await locks.release(`profile:${job.accountId}`);
  await locks.release("worker");
}
export async function expireRuns(config) {
  const barrier = await Lease.findOne({
    _id: "worker",
    blockedJobId: { $exists: true },
  });
  if (barrier) {
    const completed = await GenerationJob.findOne({
      _id: barrier.blockedJobId,
      state: "completed",
    });
    if (completed && (await GeneratedOutput.exists({ jobId: completed._id })))
      await releaseRun(completed, config, { clearBarrier: true });
  }
  for (const job of await GenerationJob.find({
    executionMode: "local",
    state: { $in: activeStates },
    leaseUntil: { $lte: new Date() },
  })) {
    const saved = await GeneratedOutput.findOne({ jobId: job._id });
    const reserved = await Lease.exists({
      _id: "worker",
      blockedJobId: job._id,
    });
    const uncertain = Boolean(!saved && (job.submissionStartedAt || reserved));
    const changed = await GenerationJob.findOneAndUpdate(
      {
        _id: job._id,
        owner: job.owner,
        fence: job.fence,
        state: { $in: activeStates },
        leaseUntil: { $lte: new Date() },
      },
      {
        $set: {
          state: saved ? "completed" : uncertain ? "needs_review" : "queued",
          remoteUncertain: uncertain,
          ...(saved ? { outputId: saved._id, progress: 100 } : {}),
          error: uncertain
            ? {
                code: "LOCAL_DISCONNECTED",
                message:
                  "Local browser disconnected after submission began. Confirm the old run has stopped before releasing the global queue.",
              }
            : undefined,
        },
      },
      { new: true },
    );
    if (!changed) continue;
    if (uncertain)
      await Lease.updateOne(
        { _id: "worker", owner: job.owner, fence: job.fence },
        { $set: { blockedJobId: job._id } },
      );
    await releaseRun(job, config, { clearBarrier: !uncertain });
    await emit(
      "local.recovered",
      `Disconnected local job moved to ${changed.state}`,
      { jobId: job._id, accountId: job.accountId },
    );
  }
}
export async function claimLocal(device, config) {
  if (config.EXECUTION_MODE !== "local")
    throw new AppError(
      "LOCAL_MODE_DISABLED",
      "Set EXECUTION_MODE=local on the VPS and restart both processes",
      409,
    );
  await expireRuns(config);
  const barrier = await Lease.findOne({
    _id: "worker",
    blockedJobId: { $exists: true },
  });
  if (barrier)
    return {
      job: null,
      reason: barrier.expiresAt > new Date() ? "busy" : "needs_review",
      blockedJobId: barrier.blockedJobId,
    };
  const first = await GenerationJob.findOne({ state: "queued" }).sort({
    enqueuedAt: 1,
    _id: 1,
  });
  if (!first) return { job: null, reason: "empty" };
  const account = await GoogleAccount.findById(first.accountId);
  if (!account || account.disabled)
    return { job: null, reason: "account_unavailable" };
  if (
    account.executionMode !== "local" ||
    String(account.deviceId) !== String(device._id)
  )
    return { job: null, reason: "waiting_for_fifo_device" };
  if (account.state !== "ready") return { job: null, reason: "needs_login" };
  const browser = device.browsers.find(
    (b) => b.id === account.browserId && b.lastSeenAt > Date.now() - 20000,
  );
  if (!browser) return { job: null, reason: "browser_offline" };
  const owner = `local:${device._id}:${crypto.randomUUID()}`;
  const locks = new LockManager(owner, config.LEASE_MS);
  const global = await locks.acquire("worker");
  if (!global) return { job: null, reason: "busy" };
  let profile,
    job,
    retained = false;
  try {
    profile = await locks.acquire(`profile:${account._id}`);
    if (!profile) return { job: null, reason: "profile_busy" };
    job = await GenerationJob.findOneAndUpdate(
      { _id: first._id, state: "queued" },
      {
        $set: {
          state: "running",
          executionMode: "local",
          deviceId: device._id,
          browserId: account.browserId,
          runId: crypto.randomUUID(),
          owner,
          fence: global.fence,
          profileFence: profile.fence,
          heartbeat: new Date(),
          leaseUntil: global.expiresAt,
          remoteRecoveryCalls: 0,
        },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    if (!job) return { job: null, reason: "busy" };
    let chat = job.chatId
      ? await GeminiChat.findOne({
          _id: job.chatId,
          accountId: account._id,
          status: { $ne: "archived" },
        })
      : null;
    if (job.chatId && !chat)
      throw new AppError(
        "CHAT_ACCOUNT",
        "Saved chat is unavailable for the selected account",
      );
    if (!chat) {
      chat = await GeminiChat.create({ accountId: account._id });
      job.chatId = chat._id;
      await job.save();
    }
    const settings = await Setting.findById("global");
    const assets = await Asset.find({ _id: { $in: job.assetIds } });
    if (assets.length !== job.assetIds.length)
      throw new AppError(
        "ASSET_MISSING",
        "A reference image is no longer available",
      );
    await emit("job.state", "Local browser claimed FIFO job", {
      jobId: job._id,
      accountId: job.accountId,
    });
    retained = true;
    return {
      job: {
        id: String(job._id),
        runId: job.runId,
        fence: job.fence,
        accountId: String(account._id),
        browserId: job.browserId,
        prompt: job.prompt,
        chatId: String(chat._id),
        chatUrl: chat.url ? chatUrl(chat.url) : null,
        assets: job.assetIds.map((id) => {
          const a = assets.find((v) => String(v._id) === String(id));
          return {
            id: String(a._id),
            name: a.originalName,
            bytes: a.bytes,
            contentType: a.contentType,
          };
        }),
        timeoutMs:
          settings?.generationTimeoutMs || config.GENERATION_TIMEOUT_MS,
        leaseMs: config.LEASE_MS,
      },
    };
  } catch (e) {
    if (job)
      await transition(job, "failed", 0, {
        error: {
          code: e.code || "LOCAL_PREPARE",
          message: e.status ? e.message : "Unable to prepare local job",
        },
        finishedAt: new Date(),
      });
    throw e;
  } finally {
    if (!retained) {
      if (profile) await locks.release(`profile:${account._id}`);
      await locks.release("worker");
    }
  }
}
export async function ownedJob(
  device,
  id,
  run,
  config,
  { renew = false } = {},
) {
  const job = await GenerationJob.findOne({
    _id: id,
    deviceId: device._id,
    runId: run.runId,
    fence: run.fence,
    state: { $in: activeStates },
  });
  if (!job)
    throw new AppError(
      "RUN_LOST",
      "Job is no longer owned by this companion",
      409,
    );
  if (job.leaseUntil <= new Date())
    throw new AppError("LEASE_LOST", "Local job lease expired", 409);
  const locks = locksFor(job, config.LEASE_MS);
  if (renew) {
    const l = await locks.heartbeat("worker");
    await locks.heartbeat(`profile:${job.accountId}`);
    job.heartbeat = new Date();
    job.leaseUntil = l.expiresAt;
    await job.save();
  }
  return job;
}
export async function finishLocal(job, dto, config) {
  const output = await GeneratedOutput.findOne({ jobId: job._id });
  const reserved = await Lease.exists({ _id: "worker", blockedJobId: job._id });
  const uncertain = Boolean(
    !output &&
    (job.submissionStartedAt || reserved) &&
    !["NO_IMAGE", "RESTRICTED"].includes(dto.code),
  );
  const state = output
    ? "completed"
    : dto.code === "NEEDS_LOGIN"
      ? "needs_login"
      : uncertain
        ? "needs_review"
        : dto.code === "CANCELLED"
          ? "cancelled"
          : "failed";
  if (uncertain)
    await Lease.updateOne(
      { _id: "worker", owner: job.owner, fence: job.fence },
      { $set: { blockedJobId: job._id } },
    );
  await transition(job, state, output ? 100 : 0, {
    remoteUncertain: uncertain,
    finishedAt: new Date(),
    ...(output
      ? { outputId: output._id }
      : { error: { code: dto.code, message: dto.message } }),
  });
  if (state === "needs_login")
    await GoogleAccount.findByIdAndUpdate(job.accountId, {
      state: "login_required",
    });
  await releaseRun(job, config, { clearBarrier: !uncertain });
  return { state };
}
