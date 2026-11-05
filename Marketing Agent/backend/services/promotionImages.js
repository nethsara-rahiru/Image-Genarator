const mongoose = require("mongoose");
const sharp = require("sharp");
const { createHash } = require("node:crypto");
const { finished } = require("node:stream/promises");
const { fail } = require("./promotionConfig");
const bucket = () =>
  new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "promotionImages",
  });
async function store(run, index, bytes) {
  let metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages || 1) > 1
    )
      throw new Error();
    // Decode pixels to reject truncated/corrupt files rather than trusting headers.
    await sharp(bytes, { limitInputPixels: 40000000 })
      .resize(1, 1)
      .raw()
      .toBuffer();
  } catch {
    throw fail(
      "IMAGE_INVALID",
      "The image service did not return a complete valid PNG, JPEG or WebP image.",
    );
  }
  const details = {
    contentType: "image/" + metadata.format,
    width: metadata.width,
    height: metadata.height,
    bytes: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
  const imageId = new mongoose.Types.ObjectId();
  const stream = bucket().openUploadStreamWithId(
    imageId,
    `promotion-${run._id}-${index + 1}.${metadata.format === "jpeg" ? "jpg" : metadata.format}`,
    {
      metadata: {
        owner: String(run.owner),
        run: String(run._id),
        index,
        ...details,
      },
    },
  );
  const done = finished(stream);
  stream.end(bytes);
  await done;
  return { imageId, ...details, completedAt: new Date() };
}
module.exports = { bucket, store };
