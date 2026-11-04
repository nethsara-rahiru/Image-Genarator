import multer from "multer";
import { imageInfo } from "./imageInfo.js";
import { nativeError } from "../native/common.js";
import { randomUUID } from "node:crypto";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 4, fileSize: 10 * 1024 * 1024, fields: 4, fieldSize: 40000 },
}).array("references", 4);
let uploading = 0;
export function referenceUpload(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  if (uploading >= 2)
    return res.status(429).json({
      error: "Two image uploads are already in progress. Try again shortly.",
    });
  uploading++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      uploading--;
    }
  };
  res.once("finish", release);
  res.once("close", release);
  upload(req, res, (error) => {
    if (error)
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        code: "GENERATION_REFERENCES",
        error:
          "Use form-data fields prompt, chatId (optional), and up to four references files, at most 10 MB each.",
      });
    next();
  });
}

export function prepareReferences(files = []) {
  if (!Array.isArray(files) || files.length > 4)
    throw nativeError(
      "GENERATION_REFERENCES",
      "Choose up to four reference images.",
    );
  return files.map((file, index) => {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length > 10 * 1024 * 1024)
      throw nativeError(
        "GENERATION_REFERENCES",
        "Each reference image must be at most 10 MB.",
      );
    const info = imageInfo(file.buffer);
    const name = String(file.originalname || "reference")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .slice(0, 100);
    return {
      ...info,
      name,
      filename: `reference-${index + 1}-${randomUUID().slice(0, 8)}.${info.format}`,
      buffer: file.buffer,
    };
  });
}
