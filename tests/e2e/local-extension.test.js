import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import { startCompanion } from "../../companion/server.js";
test(
  "ordinary-browser extension pairs locally and runs a Gemini fixture through the companion",
  { timeout: 90000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-extension-"));
    const downloads = path.join(dir, "Downloads");
    await fs.mkdir(downloads);
    const extension = path.resolve("extension");
    let companion, context;
    const image = await sharp({
      create: { width: 20, height: 18, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const job = {
      id: "000000000000000000000001",
      runId: crypto.randomUUID(),
      fence: 1,
      accountId: "000000000000000000000002",
      prompt: "Local fixture image",
      assets: [
        {
          id: "000000000000000000000003",
          name: "reference.png",
          bytes: image.length,
          contentType: "image/png",
        },
      ],
      timeoutMs: 10000,
      leaseMs: 30000,
    };
    let delivered = false,
      output = false,
      failure,
      stages = [];
    const request = async (config, p, options = {}) => {
      let data = { ok: true },
        buffer = Buffer.alloc(0);
      if (p === "/api/companion/pair")
        data = { deviceToken: "x".repeat(43), deviceId: "test-device" };
      else if (p === "/api/companion/state")
        data = {
          executionMode: "local",
          device: { name: "Test computer" },
          accounts: [],
        };
      else if (p === "/api/companion/claim") {
        if (!delivered) {
          delivered = true;
          data = {
            job: { ...job, browserId: companion.settings.browsers[0].id },
          };
        } else data = { job: null, reason: "empty" };
      } else if (p === "/api/companion/commands/claim")
        data = { command: null };
      else if (p.includes("/assets/")) buffer = image;
      else if (p.includes("/locators")) data = { items: [] };
      else if (p.endsWith("/permit")) data = { permitMs: 8000 };
      else if (p.endsWith("/progress")) stages.push(options.body.state);
      else if (p.endsWith("/output")) {
        output = true;
        assert(Buffer.isBuffer(options.body));
        assert(options.body.includes(image));
        data = { outputId: "fixture-output" };
      } else if (p.endsWith("/fail")) failure = options.body;
      return { data, buffer, status: 200, headers: {} };
    };
    try {
      companion = await startCompanion({
        port: 0,
        directory: path.join(dir, "settings"),
        openBrowser: false,
        request,
      });
      companion.settings.downloadRoot = downloads;
      const init = await (await fetch(companion.url + "/api/state")).json();
      async function local(p, body) {
        const r = await fetch(companion.url + "/api" + p, {
          method: "POST",
          headers: {
            Origin: companion.url,
            "content-type": "application/json",
            "x-csrf-token": init.csrf,
          },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      }
      await local("/connect", {
        origin: "https://fixture.invalid",
        code: "fixture-pairing-code-long",
      });
      const pairing = await local("/extension-pair", {});
      const profile = path.join(dir, "chrome");
      await fs.mkdir(path.join(profile, "Default"), { recursive: true });
      await fs.writeFile(
        path.join(profile, "Default", "Preferences"),
        JSON.stringify({
          download: {
            default_directory: downloads,
            prompt_for_download: false,
          },
        }),
      );
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        acceptDownloads: true,
        downloadsPath: downloads,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      });
      await context.route("https://gemini.google.com/**", (r) =>
        r.request().url().endsWith("/generated.png")
          ? r.fulfill({
              contentType: "image/png",
              headers: {
                "Content-Disposition": 'attachment; filename="original.png"',
              },
              body: image,
            })
          : r.fulfill({
              contentType: "text/html",
              body: `<style>img{display:block;width:100px;height:100px}</style><input type="file" multiple><rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea><button aria-label="Send message">Send</button><script>document.querySelector('input').onchange=e=>{for(const file of e.target.files){const p=document.createElement('div');p.className='attachment-preview';p.textContent=file.name;document.body.append(p);}};document.querySelector('button').onclick=()=>{history.pushState({},'', '/app/localFixture');const response=document.createElement('model-response');response.innerHTML='<div><img src="data:image/png;base64,dGV4dA=="><button aria-label="Download image">Download</button></div><div><img src="data:image/png;base64,${image.toString("base64")}"><button aria-label="Download image">Download</button></div>';for(const b of response.querySelectorAll('button'))b.onclick=()=>{const a=document.createElement('a');a.href=b.parentElement.querySelector('img').src;a.download='original.png';a.click();};document.body.append(response);};</script>`,
            }),
      );
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).hostname;
      const fixturePage = await context.newPage();
      await fixturePage.goto("https://gemini.google.com/app");
      assert.equal(
        await fixturePage.locator('[aria-label="Send message"]').count(),
        1,
      );
      const downloadSession = await context.newCDPSession(fixturePage);
      await downloadSession.send("Browser.setDownloadBehavior", {
        behavior: "default",
      });
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error")
          process.stderr.write("Extension console: " + m.text() + "\n");
      });
      await page.goto(`chrome-extension://${id}/companion.html`);
      await page.evaluate(async () => {
        const tabs = await chrome.tabs.query({
          url: "https://gemini.google.com/app",
        });
        await chrome.storage.session.set({ managedTabId: tabs[0].id });
      });
      await page.locator("[name=origin]").fill(companion.url);
      await page.locator("[name=label]").fill("Fixture Chrome profile");
      await page.locator("[name=code]").fill(pairing.code);
      await page.getByRole("button", { name: "Pair browser profile" }).click();
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.startsWith("Connected"),
      );
      const deadline = Date.now() + 55000;
      while (Date.now() < deadline && !output && !failure)
        await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        output,
        true,
        JSON.stringify({
          failure,
          stages,
          status: await page.locator("#status").innerText(),
          activity: await page.locator("#activity").innerText(),
          files: await fs.readdir(downloads),
          downloads: await page.evaluate(async () =>
            (await chrome.downloads.search({})).map((v) => ({
              filename: v.filename,
              state: v.state,
              error: v.error,
              referrer: v.referrer,
            })),
          ),
        }),
      );
      assert(stages.includes("generating"));
      assert(stages.includes("downloading"));
    } finally {
      await context?.close();
      await companion?.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
