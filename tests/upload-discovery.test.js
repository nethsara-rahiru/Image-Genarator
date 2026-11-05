import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { generationPage } from "../src/generation/page.js";

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
    const discover = () =>
      page.evaluate(generationPage, {
        origin,
        operation: "prepare_attachments",
      });
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
    await render(
      '<form><textarea></textarea><button type="button" aria-label="Add files and tools" aria-expanded="false">Add</button><input type="file" accept="image/*" disabled></form><input type="file" accept="audio/*"><model-response><button aria-label="Upload files">Misleading response</button></model-response>',
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
  },
);
