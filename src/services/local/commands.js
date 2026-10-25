import {
  GoogleAccount,
  LocalCommand,
  LocalDevice,
  Lease,
} from "../../models/index.js";
import { LockManager } from "../jobQueue.js";
import { AppError } from "../../utils/errors.js";
import { emit } from "../eventService.js";
export async function enqueueCommand(account, kind, url) {
  if (account.disabled && kind !== "close")
    throw new AppError("ACCOUNT", "Account is disabled", 409);
  if (
    account.executionMode !== "local" ||
    !account.deviceId ||
    !account.browserId
  )
    throw new AppError(
      "LOCAL_BINDING",
      "Pair a local device and bind one browser profile first",
      409,
    );
  const device = await LocalDevice.findOne({
    _id: account.deviceId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!device)
    throw new AppError("DEVICE_OFFLINE", "Paired device is unavailable", 409);
  if (
    await Lease.exists({
      _id: `profile:${account._id}`,
      expiresAt: { $gt: new Date() },
    })
  )
    throw new AppError("PROFILE_BUSY", "This account is in use", 409);
  const command = await LocalCommand.create({
    deviceId: device._id,
    accountId: account._id,
    browserId: account.browserId,
    kind,
    chatUrl: url,
    expiresAt: new Date(Date.now() + 300000),
  });
  if (["open", "open_chat"].includes(kind))
    await GoogleAccount.findByIdAndUpdate(account._id, {
      state: "authenticating",
    });
  await emit("local.command", `Local browser ${kind} requested`, {
    accountId: account._id,
  });
  return {
    mode: "local",
    pending: true,
    commandId: command._id,
    message:
      kind === "verify"
        ? "Verification requested on the paired computer. Account status updates after the browser responds."
        : kind === "close"
          ? "Close requested for the dedicated Gemini tab."
          : "Open the companion and its extension tab on the paired computer. Sign in directly in that browser, then verify from Accounts.",
  };
}
export async function claimCommand(device, config, available) {
  const command = await LocalCommand.findOne({
    deviceId: device._id,
    state: "queued",
    browserId: { $in: available },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: 1 });
  if (!command) return null;
  const locks = new LockManager(
    `command:${command._id}`,
    Math.max(60000, config.LEASE_MS),
  );
  const profile = await locks.acquire(`profile:${command.accountId}`);
  if (!profile) return null;
  const claimed = await LocalCommand.findOneAndUpdate(
    { _id: command._id, state: "queued" },
    { $set: { state: "running", profileFence: profile.fence } },
    { new: true },
  );
  if (!claimed) {
    await locks.release(`profile:${command.accountId}`);
    return null;
  }
  return {
    id: String(claimed._id),
    accountId: String(claimed.accountId),
    browserId: claimed.browserId,
    kind: claimed.kind,
    chatUrl: claimed.chatUrl,
  };
}
export async function commandResult(device, id, result, config) {
  const command = await LocalCommand.findOne({
    _id: id,
    deviceId: device._id,
    state: "running",
    expiresAt: { $gt: new Date() },
  });
  if (!command)
    throw new AppError(
      "COMMAND_LOST",
      "Command expired or already completed",
      409,
    );
  const locks = new LockManager(
    `command:${id}`,
    Math.max(60000, config.LEASE_MS),
  );
  locks.held.set(`profile:${command.accountId}`, command.profileFence);
  try {
    await locks.heartbeat(`profile:${command.accountId}`);
    if (result.error) {
      command.state = "failed";
      await GoogleAccount.findByIdAndUpdate(command.accountId, {
        state: "login_required",
      });
    } else {
      command.state = "completed";
      if (command.kind === "verify")
        await GoogleAccount.findByIdAndUpdate(command.accountId, {
          state: result.ready ? "ready" : "authenticating",
          lastVerified: new Date(),
        });
      if (command.kind === "close")
        await GoogleAccount.findByIdAndUpdate(command.accountId, {
          state: "login_required",
        });
    }
    command.result = result;
    await command.save();
    await emit(
      result.ready ? "account.verified" : "local.command_done",
      result.ready
        ? "Local signed-in Gemini UI verified"
        : result.error
          ? "Local browser action failed"
          : "Local browser action completed",
      { accountId: command.accountId },
    );
    return { ok: true };
  } finally {
    await locks.release(`profile:${command.accountId}`);
  }
}
