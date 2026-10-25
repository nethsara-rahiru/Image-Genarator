import fs from "node:fs/promises";
import { clearMonitor } from "./monitorService.js";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { GeneratedOutput } from "../models/index.js";
import { safePath, checksum } from "../utils/files.js";
import { AppError } from "../utils/errors.js";
export async function saveOutput(buffer, job, assets, config) {
  if (!buffer.length || buffer.length > 40 * 1024 * 1024)
    throw new AppError("DOWNLOAD_SIZE", "Invalid output size");
  const t = await fileTypeFromBuffer(buffer);
  if (!t || !["image/png", "image/jpeg", "image/webp"].includes(t.mime))
    throw new AppError("DOWNLOAD_TYPE", "Download is not a supported image");
  const m = await sharp(buffer, { limitInputPixels: 100000000 }).metadata();
  if (!m.width || !m.height)
    throw new AppError("DOWNLOAD_IMAGE", "Invalid image dimensions");
  const filename = `${crypto.randomUUID()}.${t.ext}`;
  const metadata = {
    jobId: String(job._id),
    accountId: String(job.accountId),
    chatId: String(job.chatId),
    prompt: job.prompt,
    inputAssets: assets.map((a) => a.originalName),
    filename,
    width: m.width,
    height: m.height,
    format: m.format,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
    submittedAt: job.submittedAt,
    queuedAt: job.enqueuedAt || job.createdAt,
    checksum: checksum(buffer),
  };
  const root = path.join(config.DATA_DIR, "outputs");
  await fs.writeFile(safePath(root, filename), buffer, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.writeFile(
    safePath(root, `${filename}.json`),
    JSON.stringify(metadata, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  try {
    return await GeneratedOutput.create({
      jobId: job._id,
      accountId: job.accountId,
      chatId: job.chatId,
      filename,
      metadata,
      contentType: t.mime,
      width: m.width,
      height: m.height,
      format: m.format,
      bytes: buffer.length,
      checksum: metadata.checksum,
    });
  } catch (e) {
    await fs.rm(safePath(root, filename), { force: true });
    await fs.rm(safePath(root, `${filename}.json`), { force: true });
    throw e;
  }
}
export async function deleteOutput(output, config) {
  await clearMonitor({ snapshotJobId: output.jobId }, config);
  for (const n of [output.filename, `${output.filename}.json`])
    await fs.rm(safePath(path.join(config.DATA_DIR, "outputs"), n), {
      force: true,
    });
  await output.deleteOne();
}
