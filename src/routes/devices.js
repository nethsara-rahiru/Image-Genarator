import { companionArchive } from "../services/local/package.js";
import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import {
  LocalDevice,
  DevicePairing,
  GoogleAccount,
  GenerationJob,
  Lease,
} from "../models/index.js";
import { tokenHash } from "./companion.js";
import { AppError } from "../utils/errors.js";
import { enqueueCommand } from "../services/local/commands.js";
import { emit } from "../services/eventService.js";
export function deviceAdminRoutes(config) {
  const r = Router();
  r.get("/companion.zip", async (req, res) => {
    res
      .attachment("gemini-local-companion.zip")
      .type("application/zip")
      .send(await companionArchive());
  });
  r.get("/", async (req, res) =>
    res.json({
      executionMode: config.EXECUTION_MODE,
      items: await LocalDevice.find()
        .select("-tokenHash")
        .sort({ createdAt: -1 })
        .limit(100),
    }),
  );
  r.post("/pairings", async (req, res) => {
    const d = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(req.body);
    const code = crypto.randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + 600000);
    await DevicePairing.create({
      name: d.name,
      codeHash: tokenHash(code),
      expiresAt,
    });
    res.json({ code, expiresAt });
  });
  r.delete("/:id", async (req, res) => {
    z.string()
      .regex(/^[a-f\d]{24}$/i)
      .parse(req.params.id);
    if (req.body.confirm !== true)
      throw new AppError("CONFIRM", "Confirm device revocation");
    const device = await LocalDevice.findByIdAndUpdate(req.params.id, {
      revokedAt: new Date(),
    });
    if (!device) throw new AppError("DEVICE", "Device not found", 404);
    await GoogleAccount.updateMany(
      { deviceId: device._id },
      { state: "login_required" },
    );
    await emit("device.revoked", "Administrator revoked a local companion");
    res.json({ ok: true });
  });
  r.post("/bindings", async (req, res) => {
    const d = z
      .object({
        accountId: z.string().regex(/^[a-f\d]{24}$/i),
        deviceId: z.string().regex(/^[a-f\d]{24}$/i),
        browserId: z.uuid(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const locks = await import("../services/jobQueue.js");
    const lock = new locks.LockManager();
    if (!(await lock.acquire(`profile:${d.accountId}`)))
      throw new AppError("PROFILE_BUSY", "Account is in use", 409);
    try {
      if (
        await GenerationJob.exists({
          accountId: d.accountId,
          state: { $in: ["queued", ...locks.activeStates] },
        })
      )
        throw new AppError(
          "ACCOUNT_BUSY",
          "Cancel pending jobs before changing its browser",
          409,
        );
      const device = await LocalDevice.findOne({
        _id: d.deviceId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      });
      if (!device?.browsers.some((b) => b.id === d.browserId))
        throw new AppError(
          "BROWSER",
          "Register this Chrome/Edge profile in the companion first",
        );
      if (
        await GoogleAccount.exists({
          _id: { $ne: d.accountId },
          deviceId: d.deviceId,
          browserId: d.browserId,
          executionMode: "local",
        })
      )
        throw new AppError(
          "PROFILE_ISOLATION",
          "Use a separate browser profile for each Google account",
          409,
        );
      const a = await GoogleAccount.findByIdAndUpdate(
        d.accountId,
        {
          executionMode: "local",
          deviceId: d.deviceId,
          browserId: d.browserId,
          state: "login_required",
        },
        { new: true },
      );
      if (!a) throw new AppError("ACCOUNT", "Account missing", 404);
      res.json(a);
    } finally {
      await lock.release(`profile:${d.accountId}`);
    }
  });
  return r;
}
export async function localAccountAction(accountId, kind, url) {
  const account = await GoogleAccount.findById(accountId);
  if (account?.executionMode !== "local") return null;
  return enqueueCommand(account, kind, url);
}
