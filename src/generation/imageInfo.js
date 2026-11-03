import { createHash } from "node:crypto";
import { jpegDimensions, nativeError } from "../native/common.js";
export function imageInfo(bytes) {
  let width, height, format, contentType;
  if (
    bytes.length >= 45 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    format = "png";
    contentType = "image/png";
    let offset = 8,
      data = false,
      end = false;
    while (offset + 12 <= bytes.length) {
      const n = bytes.readUInt32BE(offset);
      if (offset + n + 12 > bytes.length) break;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "IDAT") data = true;
      if (type === "IEND") {
        end = true;
        break;
      }
      offset += n + 12;
    }
    if (!data || !end)
      throw nativeError("INVALID_IMAGE", "The downloaded PNG is incomplete.");
  } else if (
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    ({ width, height } = jpegDimensions(bytes));
    format = "jpg";
    contentType = "image/jpeg";
  } else if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) === bytes.length - 8
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8L" && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (
      kind === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
    format = "webp";
    contentType = "image/webp";
  }
  if (!width || !height || width > 32768 || height > 32768 || !format)
    throw nativeError(
      "INVALID_IMAGE",
      "The download is not a supported, complete PNG, JPEG or WebP image.",
    );
  return {
    width,
    height,
    format,
    contentType,
    bytes: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}
