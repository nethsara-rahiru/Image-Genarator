import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";
import { startServer } from "../src/server.js";
import { configuration } from "../src/config.js";
import { GEMINI_URL } from "../src/automation/adapter.js";
import { png } from "./fixtures/png.js";
import { BrowserPipe } from "../src/automation/pipe.js";
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(80);
  }
  throw Error("Condition timed out");
}
const enabled =
  process.platform === "linux" && process.env.RUN_NATIVE_TESTS === "1";
test(
  "real local no-login generator: new/resumed chats, current image download, no-image/login/account/cancel failures",
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    // Real Chrome must complete with named files even when its completion event is lost.
    const originalEmit = BrowserPipe.prototype.emit;
    BrowserPipe.prototype.emit = function (name, ...args) {
      if (name === "Browser.downloadProgress" && args[0]?.state === "completed")
        return false;
      return originalEmit.call(this, name, ...args);
    };
    t.after(() => {
      BrowserPipe.prototype.emit = originalEmit;
    });
    let signedIn = true,
      account = "Synthetic A",
      posts = 0;
    const chats = new Map(),
      images = new Map(),
      downloads = [];
    const fixture = http.createServer((req, res) => {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname.startsWith("/img/")) {
        const bytes = images.get(url.pathname);
        if (!bytes) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader("Content-Type", "image/png");
        if (url.searchParams.has("download")) {
          downloads.push(url.pathname);
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="original.png"',
          );
        }
        res.end(bytes);
        return;
      }
      if (url.pathname.startsWith("/broken/")) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Disposition": 'attachment; filename="broken.png"',
          "Content-Length": 999999,
        });
        res.write(png().subarray(0, 16));
        setTimeout(() => res.destroy(), 100);
        return;
      }
      if (url.pathname === "/mock/generate" && req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          posts++;
          const id = data.chatId || "fixture-chat-" + posts;
          const replies = chats.get(id) || [];
          let html;
          if (data.prompt.includes("text-only"))
            html =
              '<p>Text-only response; no generated image.</p><button aria-label="Copy response">Copy</button>';
          else {
            html = "";
            for (let n = 0; n < 2; n++) {
              const file = "/img/" + posts + "-" + n + ".png";
              images.set(file, png(posts * 20 + n));
              const download = data.prompt.includes("broken-download")
                ? "/broken/" + posts
                : file + "?download=1";
              html +=
                '<div class="image-container"><img alt="Generated image" src="' +
                file +
                '"><button aria-label="Download full size" data-download="' +
                download +
                '">Download image</button></div>';
            }
            html += '<button aria-label="Copy response">Copy</button>';
          }
          replies.push({ html, prompt: data.prompt });
          chats.set(id, replies);
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              id,
              html,
              delay: data.prompt.includes("slow-job") ? 5000 : 200,
            }),
          );
        });
        return;
      }
      res.setHeader("Content-Type", "text/html");
      if (!signedIn) {
        res.end('<!doctype html><a role="button" href="/signin">Sign in</a>');
        return;
      }
      const id = url.pathname.match(/^\/app\/(.+)$/)?.[1] || "";
      const history = (chats.get(id) || [])
        .map(
          ({ html, prompt }) =>
            '<user-query><span class="query-text">' +
            prompt.replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
            "</span></user-query><model-response>" +
            html +
            "</model-response>",
        )
        .join("");
      res.end(`<!doctype html><html><head><title>Gemini-like generation fixture</title><style>body{font:16px sans-serif}model-response{display:block}.image-container button{display:none}.image-container:hover button{display:inline-block}img{width:64px;height:64px}.ql-editor{border:1px solid;padding:8px;min-height:30px}</style></head><body><button aria-label="Google Account: ${account}">Account</button><main id="responses">${history}</main><div contenteditable="true" role="textbox" class="ql-editor"></div><button id="send" aria-label="Send message">Send</button><script>
      function wire(){for(const b of document.querySelectorAll('[data-download]'))b.onclick=(event)=>{if(!event.isTrusted || !navigator.userActivation.isActive)return;const frame=document.createElement('iframe');frame.src=b.dataset.download;document.body.append(frame);};}
      wire();document.querySelector('#send').onclick=async()=>{
        const editor=document.querySelector('[contenteditable]'),prompt=editor.textContent;document.querySelector('#send').disabled=true;
        for(const old of document.querySelectorAll('model-response'))old.replaceWith(old.cloneNode(true));
        const query=document.createElement('user-query');query.textContent=prompt;document.querySelector('#responses').append(query);
        const response=document.createElement('model-response');response.setAttribute('aria-busy','true');response.textContent='Generating';document.querySelector('#responses').append(response);
        const stop=document.createElement('button');stop.setAttribute('aria-label','Stop response');stop.textContent='Stop';document.body.append(stop);
        const data=await(await fetch('/mock/generate',{method:'POST',body:JSON.stringify({prompt,chatId:location.pathname.split('/')[2]||null})})).json();
        history.replaceState({},'', '/app/'+data.id);
        setTimeout(()=>{response.innerHTML=data.html;response.removeAttribute('aria-busy');stop.remove();document.querySelector('#send').disabled=false;editor.textContent='';wire();},data.delay);
      };
    </script></body></html>`);
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    const site = `http://127.0.0.1:${fixture.address().port}`;
    t.after(() => new Promise((r) => fixture.close(r)));
    const data = await fs.mkdtemp(
      path.join(os.tmpdir(), "generation-browser-"),
    );
    const validate = async (value) => {
      if (value.startsWith(GEMINI_URL))
        return site + "/app" + value.slice(GEMINI_URL.length);
      if (value.startsWith(site + "/")) return value;
      throw Error("Private addresses are blocked");
    };
    const config = {
      ...configuration({ DATA_DIR: data, AUTO_OPEN: "false" }),
      port: 0,
      generationTimeoutMs: 15000,
    };
    const service = await startServer(config, {
      test: true,
      chromePath: process.env.TEST_CHROME,
      homepage: "about:blank",
      validateUrl: validate,
      proxyOptions: { validate },
      automationOrigins: {
        gemini: site,
        google: "https://accounts.google.com",
      },
    });
    const base = `http://127.0.0.1:${service.port}`;
    config.origin = base;
    t.after(async () => {
      await service.close();
      await fs.rm(data, { recursive: true, force: true });
    });
    let res = await fetch(base + "/api/session");
    const session = await res.json();
    assert.equal(session.authenticated, true);
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    const headers = {
      Origin: base,
      Cookie: cookie,
      "X-CSRF-Token": session.csrf,
      "Content-Type": "application/json",
    };
    const request = (url, method = "GET", body) =>
      fetch(base + url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    let key = 0;
    async function submit(prompt, chatId = null) {
      const response = await request("/api/generation/jobs", "POST", {
        prompt,
        chatId,
        idempotencyKey: "native-generation-" + ++key,
      });
      assert.equal(response.status, 202);
      return response.json();
    }
    async function final(id) {
      await until(
        () =>
          [
            "completed",
            "failed",
            "needs_review",
            "needs_login",
            "cancelled",
          ].includes(service.generation.get(id).state),
        25000,
      );
      return service.generation.get(id);
    }
    try {
      const client = await chromium.launch({
        headless: true,
        executablePath: process.env.TEST_CHROME,
        args: ["--no-sandbox"],
      });
      t.after(() => client.close());
      const page = await client.newPage({
        viewport: { width: 1400, height: 1000 },
      });
      await page.goto(base);
      await page.locator("#workspace").waitFor({ state: "visible" });
      assert.equal(await page.locator("#login-panel").isVisible(), false);
      assert.equal(await page.locator("#logout").isVisible(), false);
      assert.equal(await page.locator("canvas, .screen").count(), 0);
      assert.equal(
        await page.locator("#browser-tools").getAttribute("open"),
        null,
      );
      await page.getByRole("link", { name: "Create", exact: true }).focus();
      assert.equal(await page.locator(":focus").textContent(), "Create");
      await page.locator("#browser-tools > summary").click();
      assert.equal(await page.locator("#navigation").isVisible(), true);
      await page.locator("#browser-tools > summary").click();
      assert.equal(await page.locator("#navigation").isVisible(), false);
      await page.locator("#downloads-toggle").click();
      assert.equal(
        await page.locator("#downloads-toggle").getAttribute("aria-expanded"),
        "true",
      );
      await page.locator("#downloads-toggle").click();
      assert.equal(await page.locator("#downloads-panel").isVisible(), false);
      await page.locator("#generation-prompt").scrollIntoViewIfNeeded();
      await page
        .locator("#generation-prompt")
        .fill("first multi-image response");
      await page.locator("#generate").click();
      await until(() => service.generation.data.jobs.length === 1);
      const first = await final(service.generation.data.jobs[0].id);
      assert.equal(first.state, "completed", JSON.stringify(first.error));
      assert.equal(await page.locator("#screen").count(), 0);
      await page.waitForFunction(() => {
        const image = document.querySelector(".generation-preview");
        return image?.complete && image.naturalWidth === 64;
      });
      assert.equal(first.chatId, "fixture-chat-1");
      assert.equal(first.output.width, 64);
      let bytes = Buffer.from(
        await (
          await request("/api/generation/jobs/" + first.id + "/image")
        ).arrayBuffer(),
      );
      assert.ok(bytes.equals(png(20)));
      assert.deepEqual(downloads, ["/img/1-0.png"]);
      const second = await final(
        (
          await submit(
            "new response in saved chat featuring a rate limit sign",
            first.chatId,
          )
        ).id,
      );
      assert.equal(second.state, "completed", JSON.stringify(second.error));
      assert.equal(second.chatId, first.chatId);
      bytes = Buffer.from(
        await (
          await request("/api/generation/jobs/" + second.id + "/image")
        ).arrayBuffer(),
      );
      assert.ok(bytes.equals(png(40)));
      assert.equal(service.generation.snapshot().chats.length, 1);
      const metadata = await (
        await request("/api/generation/jobs/" + second.id + "/metadata")
      ).json();
      assert.equal(metadata.chatId, first.chatId);
      assert.equal(metadata.bytes, png(40).length);
      assert.equal(metadata.inputAssetNames.length, 0);
      const text = await final((await submit("text-only reply")).id);
      assert.equal(text.state, "failed");
      assert.equal(text.error.code, "GENERATION_NO_IMAGE");
      assert.ok(text.chatId);
      assert.equal(
        (await request("/api/generation/jobs/" + text.id + "/retry", "POST"))
          .status,
        400,
      );
      const beforeLogin = posts;
      signedIn = false;
      const needs = await final((await submit("requires login")).id);
      assert.equal(needs.state, "needs_login");
      assert.equal(posts, beforeLogin);
      signedIn = true;
      await request("/api/generation/jobs/" + needs.id + "/retry", "POST");
      assert.equal((await final(needs.id)).state, "completed");
      account = "Synthetic B";
      const beforeChange = posts;
      const mismatch = await final(
        (await submit("different account", first.chatId)).id,
      );
      assert.equal(mismatch.error.code, "GENERATION_ACCOUNT_CHANGED");
      assert.equal(posts, beforeChange);
      account = "Synthetic A";
      const broken = await final((await submit("broken-download")).id);
      assert.equal(broken.state, "needs_review");
      assert.equal(
        (await request("/api/generation/jobs/" + broken.id + "/retry", "POST"))
          .status,
        400,
      );
      const slow = await submit("slow-job");
      await until(() => service.generation.get(slow.id).state === "generating");
      await request("/api/generation/jobs/" + slow.id + "/cancel", "POST");
      assert.equal((await final(slow.id)).state, "cancelled");
      assert.equal(
        (await request("/api/generation/jobs/" + slow.id + "/retry", "POST"))
          .status,
        400,
      );
      assert.ok(
        !JSON.stringify(service.log.snapshot()).includes(
          "first multi-image response",
        ),
      );
      await page
        .locator(".generation-preview")
        .first()
        .waitFor({ state: "visible" });
      await page.waitForFunction(
        (id) =>
          [...document.querySelectorAll(".generation-job")]
            .find((e) => e.dataset.jobId === id)
            ?.querySelector("h3")
            ?.textContent.startsWith("cancelled"),
        slow.id,
      );
      // Recover the existing response with and without a new-version checkpoint.
      for (const target of [second, first]) {
        const stored = service.generation.get(target.id);
        stored.state = "needs_review";
        stored.error = {
          code: "GENERATION_DOWNLOAD_TIMEOUT",
          message: "Synthetic lost download",
        };
        if (target.id === first.id) delete stored.downloadCheckpoint;
        await service.generation.persist();
        const beforeRecovery = posts;
        assert.equal(
          (
            await request(
              "/api/generation/jobs/" + target.id + "/recover",
              "POST",
            )
          ).status,
          200,
        );
        const recovered = await final(target.id);
        assert.equal(
          recovered.state,
          "completed",
          JSON.stringify(recovered.error),
        );
        assert.equal(
          posts,
          beforeRecovery,
          "download recovery must never submit a prompt",
        );
        const output = Buffer.from(
          await (
            await request("/api/generation/jobs/" + target.id + "/image")
          ).arrayBuffer(),
        );
        assert.ok(output.equals(png(target.id === first.id ? 20 : 40)));
      }
      await page.locator("#result-filter").selectOption("completed");
      await page.waitForFunction(
        () => document.querySelectorAll(".generation-job").length === 3,
      );
      assert.equal(
        await page
          .locator('.generation-job:not([data-state="completed"])')
          .count(),
        0,
      );
      await fs.mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/image-generator-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "test-results/image-generator-mobile.png",
        fullPage: true,
      });
      const ambiguous = service.generation.get(first.id);
      ambiguous.state = "needs_review";
      ambiguous.error = {
        code: "GENERATION_DOWNLOAD_TIMEOUT",
        message: "Synthetic old job",
      };
      delete ambiguous.downloadCheckpoint;
      const replies = chats.get(first.chatId);
      replies.push(replies[0]);
      const beforeAmbiguous = posts;
      await request("/api/generation/jobs/" + first.id + "/recover", "POST");
      const refused = await final(first.id);
      assert.equal(refused.error.code, "GENERATION_RECOVERY_UNVERIFIED");
      assert.equal(posts, beforeAmbiguous);
    } catch (error) {
      await fs.mkdir("test-results", { recursive: true });
      if (service.browser.running)
        await fs.writeFile(
          "test-results/generation-failure.jpg",
          await service.browser.capture().catch(() => Buffer.alloc(0)),
        );
      console.log("Synthetic generation states", service.generation.snapshot());
      throw error;
    }
  },
);
