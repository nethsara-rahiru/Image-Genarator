import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { generationPage } from "../src/generation/page.js";
import { createHash } from "node:crypto";
import { png } from "./fixtures/png.js";

test(
  "upload discovery scopes inputs, rejects ambiguity and opens a lazy portalled menu once",
  {
    skip: process.platform !== "linux" || process.env.RUN_NATIVE_TESTS !== "1",
    timeout: 30000,
  },
  async (t) => {
    const server = http.createServer((req, res) =>
      res.end("<!doctype html><title>Upload fixture</title>"),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.TEST_CHROME,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + "/app");
    const render = (content) =>
      page.setContent(
        `<button aria-label="Google Account: Fixture">Account</button>${content}`,
      );
    const inspect = () =>
      page.evaluate(generationPage, {
        origin,
        operation: "prepare_attachments",
      });
    const discover = async () => {
      const found = await inspect();
      if (found.reason !== "click_required") return found;
      return page.evaluate(generationPage, {
        origin,
        operation: "activate_upload_control",
        targetToken: found.targetToken,
        documentId: found.documentId,
      });
    };
    await render(
      '<input id="outside" type="file" accept="image/*"><form><textarea></textarea><input id="wanted" type="file" accept="image/*" hidden></form><model-response><input type="file" accept="image/*"></model-response>',
    );
    assert.equal((await discover()).ok, true);
    assert.equal(
      await page.locator("[data-local-reference-input]").getAttribute("id"),
      "wanted",
    );
    await render(
      '<form><textarea></textarea><input type="file" accept="image/*"><input type="file" accept="image/*"></form>',
    );
    assert.equal((await discover()).reason, "ambiguous_inputs");
    assert.equal(await page.locator("[data-local-reference-input]").count(), 0);
    for (const label of ["Add files and tools", "Open upload file menu", "+"]) {
      await render(
        `<form><textarea></textarea><button type="button" aria-label="${label}">${label}</button></form>`,
      );
      const found = await inspect();
      assert.equal(found.reason, "click_required");
      assert.equal(
        found.target,
        label === "+" ? "composer_plus" : "attachment_opener",
      );
    }
    await render(
      '<form><textarea></textarea><button type="button" class="mdc-icon-button mat-mdc-icon-button" aria-label="Upload &amp; tools" aria-haspopup="menu" aria-disabled="false" aria-expanded="false"><gem-icon><mat-icon aria-hidden="true" data-mat-icon-name="plus" fonticon="plus"></mat-icon></gem-icon><span class="mat-mdc-button-touch-target"></span></button><input type="file" accept="image/*" disabled></form><input type="file" accept="audio/*"><model-response><button aria-label="Upload files">Misleading response</button></model-response>',
    );
    await page.evaluate(() => {
      window.uploadClicks = 0;
      window.misleadingClicks = 0;
      document.querySelector("model-response button").onclick = () =>
        window.misleadingClicks++;
      document.querySelector("form button").onclick = (event) => {
        window.uploadClicks++;
        event.target.setAttribute("aria-expanded", "true");
        window.revealUploadMenu = () => {
          const menu = document.createElement("div");
          menu.setAttribute("role", "menu");
          const item = document.createElement("div");
          item.setAttribute("role", "menuitem");
          item.textContent = "Upload files";
          menu.append(item);
          document.body.append(menu);
          item.onclick = () => {
            menu.remove();
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*,.pdf";
            input.id = "lazy-input";
            input.hidden = true;
            document.body.append(input);
          };
        };
      };
    });
    const candidate = await inspect();
    assert.equal(candidate.reason, "click_required");
    assert.equal(candidate.target, "attachment_opener");
    assert.equal(await page.evaluate(() => window.uploadClicks), 0);
    const staleDocument = await page.evaluate(generationPage, {
      origin,
      operation: "activate_upload_control",
      targetToken: candidate.targetToken,
      documentId: 0,
    });
    assert.equal(staleDocument.reason, "target_changed");
    assert.equal(await page.evaluate(() => window.uploadClicks), 0);
    assert.equal((await discover()).reason, "upload_menu_opened");
    await discover();
    assert.equal(await page.evaluate(() => window.uploadClicks), 1);
    await page.evaluate(() => window.revealUploadMenu());
    await page.getByRole("menuitem", { name: "Upload files" }).waitFor();
    assert.equal((await discover()).reason, "upload_menu_opened");
    assert.equal((await discover()).ok, true);
    assert.equal(
      await page.locator("[data-local-reference-input]").getAttribute("id"),
      "lazy-input",
    );
    assert.equal(await page.evaluate(() => window.misleadingClicks), 0);
    const referenceName = "reference-1-12345678.png";
    let status = await page.evaluate(generationPage, {
      origin,
      operation: "attachments_ready",
      referenceNames: [referenceName],
    });
    assert.equal(status.ok, false);
    await page.evaluate((name) => {
      const form = document.querySelector("form");
      const wrapper = document.createElement("div");
      form.before(wrapper);
      wrapper.append(form);
      const preview = document.createElement("div");
      preview.setAttribute("data-filename", name);
      preview.textContent = "Shortened reference…";
      wrapper.append(preview);
      form.setAttribute("aria-busy", "true");
    }, referenceName);
    status = await page.evaluate(generationPage, {
      origin,
      operation: "attachments_ready",
      referenceNames: [referenceName],
    });
    assert.equal(status.matchedCount, 1);
    assert.equal(status.ok, false);
    assert.ok(status.busyCount > 0);
    await page
      .locator("form")
      .evaluate((form) => form.removeAttribute("aria-busy"));
    status = await page.evaluate(generationPage, {
      origin,
      operation: "attachments_ready",
      referenceNames: [referenceName],
    });
    assert.equal(status.ok, true);
    assert.equal(status.expectedCount, 1);
    const bytes = png(39);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await page.evaluate(
      (data) => {
        document.querySelector("[data-filename]").remove();
        const image = document.createElement("img");
        image.id = "blob-attachment";
        image.alt = "attachment";
        image.className = "gem-attachment-style-img ng-star-inserted";
        image.src = URL.createObjectURL(
          new Blob([new Uint8Array(data)], { type: "image/png" }),
        );
        document.querySelector("form").append(image);
      },
      [...bytes],
    );
    await page.waitForFunction(
      () => document.querySelector("#blob-attachment").naturalWidth > 0,
    );
    const checkBlob = (checksums = [checksum], names = [referenceName]) =>
      page.evaluate(generationPage, {
        origin,
        operation: "attachments_ready",
        referenceNames: names,
        referenceChecksums: checksums,
      });
    status = await checkBlob();
    assert.equal(status.ok, true);
    assert.equal(status.nameMatchedCount, 0);
    assert.equal(status.blobMatchedCount, 1);
    assert.doesNotMatch(
      JSON.stringify(status),
      /blob:|reference-1-|[a-f0-9]{64}/,
    );
    assert.equal((await checkBlob(["0".repeat(64)])).ok, false);
    assert.equal(
      (
        await checkBlob(
          [checksum, checksum],
          [referenceName, "reference-2.png"],
        )
      ).ok,
      false,
    );
    await page.locator("#blob-attachment").evaluate((image) => {
      const clone = image.cloneNode();
      clone.id = "duplicate-preview";
      image.after(clone);
    });
    await page.waitForFunction(
      () => document.querySelector("#duplicate-preview").naturalWidth > 0,
    );
    assert.equal(
      (
        await checkBlob(
          [checksum, checksum],
          [referenceName, "reference-2.png"],
        )
      ).ok,
      false,
    );
    await page
      .locator("#duplicate-preview")
      .evaluate((image) => image.remove());
    await page
      .locator("form")
      .evaluate((form) => form.setAttribute("aria-busy", "true"));
    assert.equal((await checkBlob()).ok, false);
    await page
      .locator("form")
      .evaluate((form) => form.removeAttribute("aria-busy"));
    await page
      .locator("#blob-attachment")
      .evaluate((image) =>
        document.querySelector("model-response").append(image),
      );
    assert.equal((await checkBlob()).ok, false);
  },
);
