import { captureLocalOutput } from "../services/monitorService.js";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  Lease,
  LocalDevice,
  DevicePairing,
  GoogleAccount,
  LocalCommand,
  GenerationJob,
  Asset,
  GeminiChat,
  GeneratedOutput,
  Setting,
  ElementLocator,
} from "../models/index.js";
import { AppError } from "../utils/errors.js";
import { checksum, safePath, chatUrl } from "../utils/files.js";
import {
  claimLocal,
  ownedJob,
  finishLocal,
  releaseRun,
} from "../services/local/jobs.js";
import { claimCommand, commandResult } from "../services/local/commands.js";
import { transition } from "../services/jobQueue.js";
import { saveOutput } from "../services/outputManager.js";
import { GroqRecoveryAgent } from "../services/groqRecoveryAgent.js";
const id = z.string().regex(/^[a-f\d]{24}$/i);
const runSchema = z.object({
  runId: z.uuid(),
  fence: z.number().int().positive(),
});
export const tokenHash = (s) =>
  crypto.createHash("sha256").update(s).digest("hex");
export function companionRoutes(config) {
  const r = Router();
  r.post(
    "/pair",
    rateLimit({ windowMs: 900000, limit: 10 }),
    async (req, res) => {
      const dto = z
        .object({
          code: z.string().min(20).max(100),
          platform: z.string().max(100),
          name: z.string().min(1).max(80),
        })
        .strict()
        .parse(req.body);
      const pairing = await DevicePairing.findOneAndUpdate(
        {
          codeHash: tokenHash(dto.code),
          usedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
      );
      if (!pairing)
        throw new AppError(
          "PAIRING",
          "Pairing code is invalid, expired or already used",
          403,
        );
      const token = crypto.randomBytes(32).toString("base64url");
      const device = await LocalDevice.create({
        name: pairing.name || dto.name,
        platform: dto.platform,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 90 * 86400000),
      });
      res.json({ deviceId: device._id, deviceToken: token, protocol: 1 });
    },
  );
  r.use(async (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.get("authorization") || "",
    );
    if (!match) throw new AppError("DEVICE_AUTH", "Device token required", 401);
    const device = await LocalDevice.findOne({
      tokenHash: tokenHash(match[1]),
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!device)
      throw new AppError(
        "DEVICE_AUTH",
        "Device authorization expired or revoked",
        401,
      );
    req.device = device;
    next();
  });
  r.get("/state", async (req, res) =>
    res.json({
      protocol: 1,
      executionMode: config.EXECUTION_MODE,
      device: { id: req.device._id, name: req.device.name },
      accounts: await GoogleAccount.find({
        deviceId: req.device._id,
        executionMode: "local",
      }).select("email state disabled browserId"),
      activeJob: await GenerationJob.findOne({
        deviceId: req.device._id,
        state: {
          $in: [
            "running",
            "uploading_assets",
            "submitting_prompt",
            "generating",
            "downloading",
          ],
        },
      }).select("state progress runId"),
    }),
  );
  r.post("/heartbeat", async (req, res) => {
    const d = z
      .object({
        browsers: z
          .array(
            z
              .object({ id: z.uuid(), label: z.string().min(1).max(80) })
              .strict(),
          )
          .max(20),
        run: runSchema.extend({ jobId: id }).optional(),
      })
      .strict()
      .parse(req.body);
    await LocalDevice.updateOne(
      { _id: req.device._id },
      {
        $set: {
          lastSeenAt: new Date(),
          browsers: d.browsers.map((b) => ({ ...b, lastSeenAt: new Date() })),
        },
      },
    );
    let result = { ok: true };
    if (d.run) {
      const job = await ownedJob(req.device, d.run.jobId, d.run, config, {
        renew: true,
      });
      result = {
        ok: true,
        cancelRequested: job.cancelRequested,
        leaseMs: config.LEASE_MS,
      };
    }
    res.json(result);
  });
  r.post("/claim", async (req, res) =>
    res.json(await claimLocal(req.device, config)),
  );
  r.post("/commands/claim", async (req, res) => {
    const d = z
      .object({ available: z.array(z.uuid()).max(20) })
      .strict()
      .parse(req.body);
    res.json({ command: await claimCommand(req.device, config, d.available) });
  });
  r.post("/commands/:id/result", async (req, res) => {
    id.parse(req.params.id);
    const d = z
      .object({
        ready: z.boolean().optional(),
        opened: z.boolean().optional(),
        error: z.string().max(80).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await commandResult(req.device, req.params.id, d, config));
  });
  const authenticateRun = async (req) => {
    id.parse(req.params.id);
    const run = runSchema.parse(
      req.method === "GET"
        ? { runId: req.query.runId, fence: Number(req.query.fence) }
        : req.body,
    );
    return ownedJob(req.device, req.params.id, run, config);
  };
  r.get("/jobs/:id/result", async (req, res) => {
    id.parse(req.params.id);
    const run = runSchema.parse({
      runId: req.query.runId,
      fence: Number(req.query.fence),
    });
    const job = await GenerationJob.findOne({
      _id: req.params.id,
      deviceId: req.device._id,
      runId: run.runId,
      fence: run.fence,
    });
    if (!job)
      throw new AppError("RUN_LOST", "Job is outside this companion run", 409);
    res.json({
      state: job.state,
      remoteUncertain: job.remoteUncertain,
      outputId: job.outputId,
    });
  });
  r.get("/jobs/:id/assets/:asset", async (req, res) => {
    const job = await authenticateRun(req);
    id.parse(req.params.asset);
    if (!job.assetIds.some((v) => String(v) === req.params.asset))
      throw new AppError("ASSET_SCOPE", "Asset is not part of this job", 403);
    const a = await Asset.findById(req.params.asset);
    if (!a) throw new AppError("ASSET_MISSING", "Asset missing", 404);
    res
      .set("Cache-Control", "no-store")
      .type(a.contentType)
      .sendFile(safePath(path.join(config.DATA_DIR, "uploads"), a.filename));
  });
  r.post("/jobs/:id/progress", async (req, res) => {
    const d = runSchema
      .extend({
        state: z.enum([
          "uploading_assets",
          "submitting_prompt",
          "generating",
          "downloading",
        ]),
        chatUrl: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const job = await authenticateRun(req);
    if (job.cancelRequested)
      throw new AppError("CANCELLED", "Job cancelled", 409);
    const order = {
      running: 0,
      uploading_assets: 1,
      submitting_prompt: 2,
      generating: 3,
      downloading: 4,
    };
    if (order[d.state] < order[job.state])
      throw new AppError("STATE", "Job cannot move backwards", 409);
    if (d.state === "generating" && !job.submissionStartedAt)
      throw new AppError("STATE", "Submission permit required", 409);
    if (d.chatUrl) {
      const url = chatUrl(d.chatUrl);
      if (await GeminiChat.exists({ url, accountId: { $ne: job.accountId } }))
        throw new AppError(
          "CHAT_ACCOUNT",
          "Conversation belongs to another account",
        );
      await GeminiChat.updateOne(
        { _id: job.chatId, accountId: job.accountId },
        { $set: { url, status: "active" } },
      );
    }
    await transition(
      job,
      d.state,
      {
        uploading_assets: 15,
        submitting_prompt: 30,
        generating: 45,
        downloading: 85,
      }[d.state],
      d.state === "generating" ? { submittedAt: new Date() } : {},
    );
    res.json({ ok: true });
  });
  r.post("/jobs/:id/permit", async (req, res) => {
    runSchema.strict().parse(req.body);
    const job = await ownedJob(req.device, req.params.id, req.body, config, {
      renew: true,
    });
    if (
      job.cancelRequested ||
      job.submissionStartedAt ||
      job.state !== "submitting_prompt"
    )
      throw new AppError(
        "SUBMISSION",
        "Submission already started or cancelled; inspect conversation",
        409,
      );
    const reserved = await Lease.updateOne(
      {
        _id: "worker",
        owner: job.owner,
        fence: job.fence,
        expiresAt: { $gt: new Date() },
        blockedJobId: { $exists: false },
      },
      { $set: { blockedJobId: job._id } },
    );
    if (!reserved.modifiedCount)
      throw new AppError(
        "SUBMISSION",
        "Run already reserved or lease lost",
        409,
      );
    const changed = await GenerationJob.findOneAndUpdate(
      {
        _id: job._id,
        owner: job.owner,
        fence: job.fence,
        submissionStartedAt: null,
        cancelRequested: false,
      },
      { $set: { submissionStartedAt: new Date() } },
      { new: true },
    );
    if (!changed)
      throw new AppError(
        "SUBMISSION",
        "Submission permit already consumed",
        409,
      );
    res.json({ permitMs: Math.min(8000, Math.floor(config.LEASE_MS / 3)) });
  });
  r.post("/jobs/:id/fail", async (req, res) => {
    const d = runSchema
      .extend({
        code: z.enum([
          "NEEDS_LOGIN",
          "NO_IMAGE",
          "RESTRICTED",
          "CANCELLED",
          "LOCAL_DISCONNECTED",
          "AUTOMATION",
          "DOWNLOAD_FAILED",
          "UPLOAD_FAILED",
          "LOST_TASK_CONTEXT",
        ]),
        message: z.string().max(200),
      })
      .strict()
      .parse(req.body);
    const job = await authenticateRun(req);
    res.json(
      await finishLocal(
        job,
        {
          code: d.code,
          message: {
            NEEDS_LOGIN:
              "Sign in directly in the paired browser and verify again",
            NO_IMAGE: "Gemini completed without a valid image",
            RESTRICTED:
              "Google security or usage restriction requires manual intervention",
            CANCELLED: "Local job cancelled",
            LOCAL_DISCONNECTED:
              "Companion disconnected; inspect the conversation",
            AUTOMATION: "Browser action failed; inspect the paired browser",
            DOWNLOAD_FAILED: "Original image download could not be verified",
            UPLOAD_FAILED: "Reference image upload could not be verified",
            LOST_TASK_CONTEXT:
              "Local browser restarted; inspect the conversation",
          }[d.code],
        },
        config,
      ),
    );
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 40 * 1024 * 1024, files: 1, fields: 2 },
  });
  r.post("/jobs/:id/output", upload.single("image"), async (req, res) => {
    req.body = { runId: req.body.runId, fence: Number(req.body.fence) };
    const job = await authenticateRun(req);
    if (
      !job.submissionStartedAt ||
      job.state !== "downloading" ||
      job.cancelRequested
    )
      throw new AppError("STATE", "Job is not accepting an output", 409);
    if (!req.file) throw new AppError("OUTPUT", "Original image required");
    const assets = await Asset.find({ _id: { $in: job.assetIds } });
    const output = await saveOutput(req.file.buffer, job, assets, config);
    await captureLocalOutput(req.file.buffer, job, config).catch(() => {});
    await transition(job, "completed", 100, {
      outputId: output._id,
      finishedAt: new Date(),
    });
    await releaseRun(job, config, { clearBarrier: true });
    res.json({ outputId: output._id, metadata: output.metadata });
  });
  r.post("/jobs/:id/recover", async (req, res) => {
    const d = runSchema
      .extend({
        action: z.enum(["composer", "upload"]),
        candidates: z
          .array(
            z
              .object({
                tag: z.enum(["BUTTON", "INPUT", "TEXTAREA", "DIV"]),
                role: z.string().nullable(),
                label: z.string().max(80),
                type: z.string().nullable().optional(),
              })
              .strict(),
          )
          .max(40),
      })
      .strict()
      .parse(req.body);
    const job = await authenticateRun(req);
    const budget = await GenerationJob.updateOne(
      { _id: job._id, remoteRecoveryCalls: { $lt: 3 } },
      { $inc: { remoteRecoveryCalls: 1 } },
    );
    if (!budget.modifiedCount)
      throw new AppError("RECOVERY_BUDGET", "Recovery budget exhausted");
    const settings = (await Setting.findById("global")) || {};
    res.json(
      await new GroqRecoveryAgent(config, settings).choose(
        d.action,
        d.candidates,
      ),
    );
  });
  r.get("/jobs/:id/locators", async (req, res) => {
    await authenticateRun(req);
    res.json({
      items: await ElementLocator.find({ context: "gemini-local" }).select(
        "action type value successes failures",
      ),
    });
  });
  r.post("/jobs/:id/locator", async (req, res) => {
    const d = runSchema
      .extend({
        action: z.enum(["composer", "upload"]),
        value: z.string().max(250),
        verified: z.boolean(),
      })
      .strict()
      .parse(req.body);
    await authenticateRun(req);
    if (
      !/^(textarea|input|div|rich-textarea)[a-zA-Z0-9\s_.\[\]="'\\:*-]+$/.test(
        d.value,
      ) ||
      /[<>@]/.test(d.value)
    )
      throw new AppError("LOCATOR", "Unsafe locator");
    const old = await ElementLocator.findOne({
      context: "gemini-local",
      action: d.action,
    });
    if (d.verified)
      await ElementLocator.findOneAndUpdate(
        { context: "gemini-local", action: d.action },
        {
          $set: { type: "css", value: d.value, lastVerified: new Date() },
          $inc: { successes: 1 },
          $push: {
            history: {
              $each: [
                {
                  value: old?.value || d.value,
                  type: "css",
                  at: new Date(),
                  verified: true,
                },
              ],
              $slice: -20,
            },
          },
        },
        { upsert: true },
      );
    else if (old)
      await ElementLocator.updateOne(
        { _id: old._id },
        { $inc: { failures: 1 } },
      );
    res.json({ ok: true });
  });
  return r;
}
