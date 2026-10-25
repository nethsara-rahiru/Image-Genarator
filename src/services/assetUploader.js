import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { Asset } from "../models/index.js";
import { AppError } from "../utils/errors.js";
import { safePath, checksum, cleanName } from "../utils/files.js";
export async function storeAsset(file, config) {
  const type = await fileTypeFromBuffer(file.buffer);
  if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime))
    throw new AppError("UPLOAD_TYPE", "PNG, JPEG or WebP required");
  const meta = await sharp(file.buffer, {
    limitInputPixels: 40000000,
  }).metadata();
  if (!meta.width || !meta.height || meta.pages > 1)
    throw new AppError("UPLOAD_IMAGE", "Invalid or animated image");
  const filename = `${crypto.randomUUID()}.${type.ext}`;
  const location = safePath(path.join(config.DATA_DIR, "uploads"), filename);
  await fs.writeFile(location, file.buffer, { mode: 0o600, flag: "wx" });
  try {
    return await Asset.create({
      filename,
      originalName: cleanName(file.originalname),
      contentType: type.mime,
      bytes: file.size,
      checksum: checksum(file.buffer),
    });
  } catch (e) {
    await fs.rm(location, { force: true });
    throw e;
  }
}
