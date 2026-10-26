import { Router } from "express";
import mongoose from "mongoose";
import argon2 from "argon2";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AdminUser,
  GoogleAccount,
  GeminiChat,
  GenerationJob,
  GeneratedOutput,
  Asset,
  Lease,
  AutomationEvent,
  ElementLocator,
  Setting,
} from "../models/index.js";
import { requireAdmin, confirm } from "../middleware/security.js";
import { AppError } from "../utils/errors.js";
import { enqueue, activeStates, LockManager } from "../services/jobQueue.js";
import { storeAsset } from "../services/assetUploader.js";
import { deleteOutput } from "../services/outputManager.js";
import { emit } from "../services/eventService.js";
import { clearMonitor } from "../services/monitorService.js";
import { safePath, chatUrl } from "../utils/files.js";
const id = z.string().regex(/^[a-f\d]{24}$/i);
const paging = (req) => {
  const d = z
    .object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .parse(req.query);
  return { limit: d.limit, skip: (d.page - 1) * d.limit };
};
const get = async (Model, key) => {
  id.parse(key);
  const v = await Model.findById(key);
  if (!v) throw new AppError("NOT_FOUND", "Record not found", 404);
  return v;
};
async function list(Model, req, filter = {}) {
  const { limit, skip } = paging(req);
  return {
    items: await Model.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    total: await Model.countDocuments(filter),
    page: Math.floor(skip / limit) + 1,
    limit,
  };
}
export function routes(config, accounts) {
  const r = Router();
  r.get("/health", async (req, res) =>
    res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
      status: mongoose.connection.readyState === 1 ? "ok" : "degraded",
      database: mongoose.connection.readyState === 1,
    }),
  );
  r.get("/auth/me", async (req, res) =>
    res.json({
      authenticated: Boolean(req.session.adminId),
      csrf: req.session.csrf,
    }),
  );
  r.post(
    "/auth/login",
    rateLimit({
      windowMs: 900000,
      limit: 8,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const d = z
        .object({
          username: z.string().min(1).max(100),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(req.body);
      const u = await AdminUser.findOne({ singleton: "admin" }).select(
        "+passwordHash",
      );
      if (
        !u ||
        u.username !== d.username ||
        !(await argon2.verify(u.passwordHash, d.password))
      )
        throw new AppError("LOGIN", "Invalid credentials", 401);
      await new Promise((resolve, reject) =>
        req.session.regenerate((e) => (e ? reject(e) : resolve())),
      );
      req.session.adminId = String(u._id);
      req.session.csrf = (await import("node:crypto"))
        .randomBytes(32)
        .toString("hex");
      await emit("auth.login", "Administrator signed in");
      res.json({ csrf: req.session.csrf });
    },
  );
  r.use(requireAdmin);
  r.post("/auth/logout", (req, res, next) =>
    req.session.destroy((e) =>
      e ? next(e) : res.clearCookie("gemini.sid").json({ ok: true }),
    ),
  );
  r.post("/auth/password", async (req, res) => {
    const d = z
      .object({
        currentPassword: z.string().max(256),
        newPassword: z.string().min(14).max(256),
      })
      .strict()
      .parse(req.body);
    const u = await AdminUser.findById(req.session.adminId).select(
      "+passwordHash",
    );
    if (!(await argon2.verify(u.passwordHash, d.currentPassword)))
      throw new AppError("PASSWORD", "Current password is incorrect", 403);
    u.passwordHash = await argon2.hash(d.newPassword, {
      type: argon2.argon2id,
    });
    await u.save();
    await mongoose.connection.db.collection("sessions").deleteMany({});
    res.clearCookie("gemini.sid").json({ ok: true });
  });
  r.get("/accounts", async (req, res) =>
    res.json(await list(GoogleAccount, req)),
  );
  r.post("/accounts", async (req, res) =>
    res.status(201).json(
      await GoogleAccount.create(
        z
          .object({ email: z.email().max(254) })
          .strict()
          .parse(req.body),
      ),
    ),
  );
  r.get("/accounts/:id", async (req, res) =>
    res.json(await get(GoogleAccount, req.params.id)),
  );
  r.get("/accounts/:id/status", async (req, res) =>
    res.json(await get(GoogleAccount, req.params.id)),
  );
  r.patch("/accounts/:id", async (req, res) => {
    const a = await get(GoogleAccount, req.params.id);
    const d = z.object({ disabled: z.boolean() }).strict().parse(req.body);
    if (
      await Lease.exists({
        _id: `profile:${a._id}`,
        expiresAt: { $gt: new Date() },
      })
    )
      throw new AppError(
        "PROFILE_BUSY",
        "Close active account browser first",
        409,
      );
    Object.assign(a, d);
    await a.save();
    res.json(a);
  });
  r.get("/accounts/:id/login/status", async (req, res) => {
    await get(GoogleAccount, req.params.id);
    res.json(accounts.status(req.params.id));
  });
  r.post("/accounts/:id/login/gemini", async (req, res) => {
    id.parse(req.params.id);
    res.json(await accounts.openGemini(req.params.id));
  });
  r.post("/accounts/:id/login", async (req, res) => {
    id.parse(req.params.id);
    res.json(await accounts.login(req.params.id));
  });
  r.post("/accounts/:id/verify", async (req, res) => {
    id.parse(req.params.id);
    res.json(await accounts.verify(req.params.id));
  });
  r.post("/accounts/:id/login/close", async (req, res) => {
    id.parse(req.params.id);
    res.json(await accounts.finish(req.params.id, false));
  });
  r.delete("/accounts/:id", confirm, async (req, res) => {
    const a = await get(GoogleAccount, req.params.id);
    const locks = new LockManager();
    if (!(await locks.acquire(`profile:${a._id}`)))
      throw new AppError("PROFILE_BUSY", "Account browser active", 409);
    try {
      if (
        await GenerationJob.exists({
          accountId: a._id,
          state: { $in: ["queued", ...activeStates] },
        })
      )
        throw new AppError("ACCOUNT_BUSY", "Cancel pending jobs first", 409);
      await fs.rm(
        safePath(path.join(config.DATA_DIR, "profiles"), String(a._id)),
        { recursive: true, force: true },
      );
      await GeminiChat.updateMany({ accountId: a._id }, { status: "archived" });
      await clearMonitor({ snapshotAccountId: a._id }, config);
      await a.deleteOne();
      res.json({ ok: true });
    } finally {
      await locks.release(`profile:${a._id}`);
    }
  });
  r.get("/chats", async (req, res) => {
    const filter = {};
    if (req.query.accountId) filter.accountId = id.parse(req.query.accountId);
    res.json(await list(GeminiChat, req, filter));
  });
  r.post("/chats", async (req, res) => {
    const d = z
      .object({
        accountId: id,
        title: z.string().min(1).max(120).default("New chat"),
      })
      .strict()
      .parse(req.body);
    await get(GoogleAccount, d.accountId);
    res.status(201).json(await GeminiChat.create(d));
  });
  r.post("/chats/:id/open", async (req, res) => {
    const chat = await get(GeminiChat, req.params.id);
    if (chat.status !== "active" || !chat.url)
      throw new AppError("CHAT_PENDING", "Conversation has no saved URL yet");
    const result = await accounts.login(chat.accountId);
    try {
      await accounts.logins
        .get(String(chat.accountId))
        .page.goto(chatUrl(chat.url), {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      res.json(result);
    } catch (e) {
      await accounts.finish(chat.accountId, false);
      throw e;
    }
  });
  r.get("/chats/:id", async (req, res) =>
    res.json(await get(GeminiChat, req.params.id)),
  );
  r.patch("/chats/:id", async (req, res) => {
    const c = await get(GeminiChat, req.params.id);
    Object.assign(
      c,
      z
        .object({ title: z.string().min(1).max(120) })
        .strict()
        .parse(req.body),
    );
    await c.save();
    res.json(c);
  });
  r.delete("/chats/:id", confirm, async (req, res) => {
    const c = await get(GeminiChat, req.params.id);
    if (
      await GenerationJob.exists({
        chatId: c._id,
        state: { $in: ["queued", ...activeStates] },
      })
    )
      throw new AppError("CHAT_BUSY", "Chat has pending jobs", 409);
    c.status = "archived";
    await c.save();
    res.json({ ok: true });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 0 },
  });
  r.post("/assets", upload.array("files", 5), async (req, res) => {
    if (!req.files?.length) throw new AppError("UPLOAD", "No files uploaded");
    const files = [];
    try {
      for (const file of req.files) files.push(await storeAsset(file, config));
      res.status(201).json({
        items: files.map((a) => ({
          _id: a._id,
          originalName: a.originalName,
          bytes: a.bytes,
        })),
      });
    } catch (e) {
      for (const a of files) {
        await fs.rm(
          safePath(path.join(config.DATA_DIR, "uploads"), a.filename),
          { force: true },
        );
        await a.deleteOne();
      }
      throw e;
    }
  });
  r.post("/generate", async (req, res) => {
    const d = z
      .object({
        accountId: id,
        chatId: id.optional(),
        createNew: z.boolean().default(true),
        prompt: z.string().trim().min(1).max(12000),
        assetIds: z.array(id).max(5).default([]),
      })
      .strict()
      .parse(req.body);
    if (d.chatId && d.createNew)
      throw new AppError("CHAT", "Choose saved chat or new chat");
    if (!d.chatId && !d.createNew)
      throw new AppError("CHAT", "Chat selection required");
    if (new Set(d.assetIds).size !== d.assetIds.length)
      throw new AppError("ASSETS", "Duplicate assets");
    const key = z.string().min(8).max(128).parse(req.get("idempotency-key"));
    res.status(202).json(await enqueue(d, key));
  });
  r.get("/jobs", async (req, res) => {
    const f = {};
    if (req.query.state)
      f.state = z
        .enum([
          "queued",
          ...activeStates,
          "completed",
          "failed",
          "cancelled",
          "needs_login",
          "needs_review",
        ])
        .parse(req.query.state);
    if (req.query.accountId) f.accountId = id.parse(req.query.accountId);
    const data = await list(GenerationJob, req, f);
    for (const j of data.items) {
      j.$locals.position =
        j.state === "queued"
          ? await GenerationJob.countDocuments({
              state: "queued",
              $or: [
                { enqueuedAt: { $lt: j.enqueuedAt } },
                { enqueuedAt: j.enqueuedAt, _id: { $lte: j._id } },
              ],
            })
          : null;
    }
    res.json({
      ...data,
      items: data.items.map((j) => ({
        ...j.toObject(),
        queuePosition: j.$locals.position,
      })),
    });
  });
  r.get("/jobs/:id", async (req, res) => {
    const j = await get(GenerationJob, req.params.id);
    res.json({
      ...j.toObject(),
      events: await AutomationEvent.find({ jobId: j._id })
        .sort({ createdAt: 1 })
        .limit(200),
    });
  });
  r.post("/jobs/:id/cancel", async (req, res) => {
    const j = await get(GenerationJob, req.params.id);
    const q = await GenerationJob.findOneAndUpdate(
      { _id: j._id, state: "queued" },
      { $set: { state: "cancelled", finishedAt: new Date() } },
      { new: true },
    );
    if (!q)
      await GenerationJob.updateOne(
        { _id: j._id, state: { $in: activeStates } },
        { $set: { cancelRequested: true } },
      );
    res.json(await get(GenerationJob, j._id.toString()));
  });
  r.post("/jobs/:id/retry", async (req, res) => {
    const j = await get(GenerationJob, req.params.id);
    if (
      !["failed", "needs_login", "needs_review", "cancelled"].includes(j.state)
    )
      throw new AppError("RETRY", "Job cannot be retried", 409);
    const settings = await Setting.findById("global");
    if (j.attempts >= (settings?.retryLimit ?? 1) + 1)
      throw new AppError("RETRY_LIMIT", "Retry budget exhausted", 409);
    if (j.submissionStartedAt && req.body.confirm !== true)
      throw new AppError(
        "AMBIGUOUS",
        "Inspect the conversation and confirm possible duplicate generation before retry",
        409,
      );
    const result = await GenerationJob.findOneAndUpdate(
      { _id: j._id, state: j.state, attempts: j.attempts },
      {
        $set: {
          state: "queued",
          cancelRequested: false,
          progress: 0,
          enqueuedAt: new Date(),
        },
        $unset: {
          submissionStartedAt: 1,
          submittedAt: 1,
          error: 1,
          finishedAt: 1,
          owner: 1,
          fence: 1,
        },
      },
      { new: true },
    );
    if (!result) throw new AppError("CONFLICT", "Job state changed", 409);
    await emit("job.retry", "Administrator requested retry", { jobId: j._id });
    res.json(result);
  });
  r.get("/outputs", async (req, res) =>
    res.json(await list(GeneratedOutput, req)),
  );
  r.get("/outputs/:id", async (req, res) =>
    res.json(await get(GeneratedOutput, req.params.id)),
  );
  r.get("/outputs/:id/image", async (req, res) => {
    const o = await get(GeneratedOutput, req.params.id);
    res.type(o.contentType);
    res.set("Cache-Control", "private, no-store");
    if (req.query.download === "1") res.attachment(o.filename);
    res.sendFile(safePath(path.join(config.DATA_DIR, "outputs"), o.filename));
  });
  r.get("/outputs/:id/metadata", async (req, res) => {
    const o = await get(GeneratedOutput, req.params.id);
    res.attachment(`${o.filename}.json`).json(o.metadata);
  });
  r.delete("/outputs/:id", confirm, async (req, res) => {
    const o = await get(GeneratedOutput, req.params.id);
    await deleteOutput(o, config);
    res.json({ ok: true });
  });
  r.get("/worker/status", async (req, res) => {
    const l = await Lease.findById("worker");
    res.json({
      online: Boolean(l?.owner && l.expiresAt > new Date()),
      heartbeatExpiry: l?.expiresAt,
      screenshotAvailable: Boolean(l?.snapshotAt),
      screenshotAt: l?.snapshotAt,
      screenshotJobId: l?.snapshotJobId,
      activeJob: await GenerationJob.findOne({
        state: { $in: activeStates },
      }).select("state progress accountId updatedAt"),
      profiles: await Lease.countDocuments({
        _id: /^profile:/,
        expiresAt: { $gt: new Date() },
      }),
    });
  });
  r.get("/worker/screenshot", async (req, res) => {
    const l = await Lease.findById("worker");
    if (!l?.snapshotAt)
      throw new AppError(
        "NO_SCREENSHOT",
        "No sanitized response image capture available",
        404,
      );
    res.set("Cache-Control", "no-store");
    res
      .type("png")
      .sendFile(
        safePath(path.join(config.DATA_DIR, "monitor"), l.snapshotFilename),
      );
  });
  r.get("/overview", async (req, res) => {
    const counts = await GenerationJob.aggregate([
      { $group: { _id: "$state", count: { $sum: 1 } } },
    ]);
    res.json({
      accounts: await GoogleAccount.countDocuments(),
      readyAccounts: await GoogleAccount.countDocuments({
        state: "ready",
        disabled: false,
      }),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
      events: await AutomationEvent.find().sort({ _id: -1 }).limit(15),
    });
  });
  r.get("/recovery", async (req, res) =>
    res.json({
      locators: await list(ElementLocator, req),
      events: await AutomationEvent.find({ type: /^recovery\./ })
        .sort({ _id: -1 })
        .limit(100),
    }),
  );
  r.post("/recovery/:id/rollback", async (req, res) => {
    const l = await get(ElementLocator, req.params.id);
    const history = l.history.filter((h) => h.verified && h.value !== l.value);
    if (!history.length)
      throw new AppError("ROLLBACK", "No previous verified revision");
    l.value = history.at(-1).value;
    l.lastVerified = undefined;
    await l.save();
    res.json(l);
  });
  r.get("/settings", async (req, res) =>
    res.json({
      settings: await Setting.findById("global"),
      groqKeyConfigured: Boolean(config.GROQ_API_KEY),
      groqModel: config.GROQ_MODEL,
      storage: "Local protected runtime directory",
      monitorScreenshots: "current-response image only",
    }),
  );
  r.patch("/settings", async (req, res) => {
    const d = z
      .object({
        generationTimeoutMs: z.number().int().min(30000).max(900000).optional(),
        retryLimit: z.number().int().min(0).max(3).optional(),
        retentionDays: z.number().int().min(1).max(365).optional(),
        groqEnabled: z.boolean().optional(),
        groqModel: z
          .string()
          .regex(/^[a-zA-Z0-9_.\/-]{1,100}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await Setting.findOneAndUpdate(
        { _id: "global" },
        { $set: d },
        { upsert: true, new: true, runValidators: true },
      ),
    );
  });
  r.get("/events", async (req, res) => {
    let cursor = req.get("last-event-id") || req.query.after;
    if (cursor) id.parse(cursor);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    while (!closed) {
      try {
        await new Promise((resolve, reject) =>
          req.session.reload((e) => (e ? reject(e) : resolve())),
        );
        if (
          !req.session.adminId ||
          new Date(req.session.cookie.expires) <= new Date()
        ) {
          if (!closed) res.end();
          return;
        }
        const events = await AutomationEvent.find(
          cursor ? { _id: { $gt: cursor } } : {},
        )
          .sort({ _id: 1 })
          .limit(100);
        for (const e of events) {
          res.write(`id: ${e._id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = String(e._id);
        }
        res.write(": heartbeat\n\n");
      } catch {
        if (!closed) res.end();
        return;
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        t.unref();
      });
    }
    // Client already closed the transport; do not touch sessions after disconnect.
  });
  return r;
}
