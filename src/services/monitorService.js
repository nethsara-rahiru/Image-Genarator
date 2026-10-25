import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Lease } from "../models/index.js";
import { signedIn } from "./browserManager.js";
import { safePath } from "../utils/files.js";
export async function clearMonitor(filter, config) {
  const previous = await Lease.findOneAndUpdate(
    { _id: "worker", ...filter },
    {
      $unset: {
        snapshotAt: 1,
        snapshotJobId: 1,
        snapshotAccountId: 1,
        snapshotFilename: 1,
      },
    },
  );
  if (previous?.snapshotFilename)
    await fs.rm(
      safePath(
        path.join(config.DATA_DIR, "monitor"),
        previous.snapshotFilename,
      ),
      { force: true },
    );
}
export async function captureMonitor(session, response, job, config, lock) {
  // Capture only a worker-owned current-response image; no page chrome or login UI.
  if (session.login !== false || !(await signedIn(session.page))) return false;
  const image = response.locator("img").filter({ visible: true }).first();
  if (!(await image.count())) return false;
  const buffer = await image.screenshot({
    type: "png",
    animations: "disabled",
    timeout: 5000,
  });
  if (buffer.length > 5 * 1024 * 1024) return false;
  await lock.heartbeat("worker");
  const root = path.join(config.DATA_DIR, "monitor");
  const filename = `${crypto.randomUUID()}.png`;
  const location = safePath(root, filename);
  await fs.writeFile(location, buffer, { flag: "wx", mode: 0o600 });
  const previous = await Lease.findOneAndUpdate(
    {
      _id: "worker",
      owner: lock.owner,
      fence: lock.held.get("worker"),
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        snapshotJobId: job._id,
        snapshotAccountId: job.accountId,
        snapshotFilename: filename,
        snapshotAt: new Date(),
      },
    },
  );
  if (!previous) {
    await fs.rm(location, { force: true });
    return false;
  }
  if (previous.snapshotFilename)
    await fs.rm(safePath(root, previous.snapshotFilename), { force: true });
  return true;
}
