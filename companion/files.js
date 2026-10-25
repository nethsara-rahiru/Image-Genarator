import fs from "node:fs/promises";
import path from "node:path";
export async function readDownload(root, filename, runId) {
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(filename) ||
    !path.basename(filename).startsWith(`gemini-agent-${runId}-`)
  )
    throw new Error("Download filename does not belong to this run");
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(filename);
  if (path.dirname(real) !== realRoot)
    throw new Error("Download is outside the configured Downloads folder");
  const stat = await fs.stat(real);
  if (!stat.isFile() || !stat.size || stat.size > 40 * 1024 * 1024)
    throw new Error("Invalid download size");
  return fs.readFile(real);
}
export function imageInfo(b) {
  let width, height, format;
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
    format = "png";
  } else if (b.length > 12 && b[0] === 255 && b[1] === 216) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i++] !== 255) continue;
      let marker = b[i++];
      while (marker === 255 && i < b.length) marker = b[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const n = b.readUInt16BE(i);
      if (n < 2 || i + n > b.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        height = b.readUInt16BE(i + 3);
        width = b.readUInt16BE(i + 5);
        format = "jpeg";
        break;
      }
      i += n;
    }
  } else if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    const type = b.toString("ascii", 12, 16);
    format = "webp";
    if (type === "VP8X") {
      width = 1 + b.readUIntLE(24, 3);
      height = 1 + b.readUIntLE(27, 3);
    } else if (
      type === "VP8 " &&
      b[23] === 157 &&
      b[24] === 1 &&
      b[25] === 42
    ) {
      width = b.readUInt16LE(26) & 16383;
      height = b.readUInt16LE(28) & 16383;
    } else if (type === "VP8L" && b[20] === 47) {
      const n = b.readUInt32LE(21);
      width = 1 + (n & 16383);
      height = 1 + ((n >>> 14) & 16383);
    }
  }
  if (!width || !height || width * height > 100000000)
    throw new Error("Download is not a supported valid image");
  return { width, height, format, bytes: b.length };
}
export function multipartImage(buffer, run) {
  const boundary = `gemini-${run.runId}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="runId"\r\n\r\n${run.runId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="fence"\r\n\r\n${run.fence}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
