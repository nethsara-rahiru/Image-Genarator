import fs from "node:fs/promises";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../utils/errors.js";
export async function downloadImage(page, response) {
  const images = response.locator("img").filter({ visible: true });
  if (!(await images.count()))
    throw new AppError("NO_IMAGE", "The current response contains no image");
  for (let index = 0; index < (await images.count()); index++) {
    const image = images.nth(index);
    const card = image.locator("xpath=..");
    const local = card.getByRole("button", { name: /download/i });
    const global = response.getByRole("button", { name: /download/i });
    // An unassociated response-level button is safe only for one image and one control.
    const button =
      (await local.count()) === 1
        ? local
        : (await images.count()) === 1 && (await global.count()) === 1
          ? global
          : null;
    if (!button) continue;
    const pending = page.waitForEvent("download", { timeout: 30000 });
    await button.click();
    const download = await pending;
    if (await download.failure())
      throw new AppError("DOWNLOAD_FAILED", "Image download interrupted");
    const location = await download.path();
    const stat = await fs.stat(location);
    if (!stat.size || stat.size > 40 * 1024 * 1024) continue;
    const buffer = await fs.readFile(location);
    const type = await fileTypeFromBuffer(buffer);
    if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime))
      continue;
    try {
      const m = await sharp(buffer, { limitInputPixels: 100000000 }).metadata();
      if (m.width && m.height) return buffer;
    } catch {
      /* Skip invalid candidates in DOM order. */
    }
  }
  throw new AppError(
    "NO_VALID_IMAGE",
    "No valid downloadable image could be associated with the current response",
  );
}
