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
import { createClient } from "../src/apiClients.js";
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
    let releaseAcks,
      acksReleased = false,
      releaseSeen = false,
      backgroundTarget;
    const ackGate = new Promise((resolve) => {
      releaseAcks = () => {
        acksReleased = true;
        resolve();
      };
    });
    const originalSend = BrowserPipe.prototype.send;
    BrowserPipe.prototype.send = function (method, params = {}, sessionId) {
      const result = originalSend.call(this, method, params, sessionId);
      if (
        !releaseSeen &&
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseReleased"
      ) {
        releaseSeen = true;
        return result.then(async (value) => {
          const target = await originalSend.call(this, "Target.createTarget", {
            url: "about:blank",
          });
          backgroundTarget = target.targetId;
          await originalSend.call(this, "Target.activateTarget", {
            targetId: backgroundTarget,
          });
          await ackGate;
          return value;
        });
      }
      if (!acksReleased && method === "Network.disable")
        return result.then(async (value) => {
          await ackGate;
          return value;
        });
      return result;
    };
    const originalEmit = BrowserPipe.prototype.emit;
    BrowserPipe.prototype.emit = function (name, ...args) {
      if (name === "Browser.downloadProgress" && args[0]?.state === "completed")
        return false;
      return originalEmit.call(this, name, ...args);
    };
    t.after(() => {
      releaseAcks();
      BrowserPipe.prototype.emit = originalEmit;
      BrowserPipe.prototype.send = originalSend;
    });
    let signedIn = true,
      account = "Synthetic A",
      posts = 0,
      hydrations = 0;
    const chats = new Map(),
      images = new Map(),
      downloads = [],
      receivedReferences = [],
      uploadWaits = [];
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
      if (url.pathname === "/prepare") {
        res.setHeader("Content-Type", "application/json");
        setTimeout(
          () => res.end(JSON.stringify({ url: url.searchParams.get("file") })),
          250,
        );
        return;
      }
      if (url.pathname === "/mock/generate" && req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          posts++;
          receivedReferences.push(data.references || []);
          uploadWaits.push(data.uploadWaitMs);
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
      res.end(`<!doctype html><html><head><title>Gemini-like generation fixture</title><style>html{scroll-behavior:smooth}body{font:16px sans-serif}model-response{display:block}.image-container button{display:none}.image-container:hover button{display:inline-block}img{width:64px;height:64px}.ql-editor{border:1px solid;padding:8px;min-height:30px}</style></head><body><button aria-label="Google Account: ${account}">Account</button><main id="responses">${history}</main><form><div id="attachments"></div><button type="button" id="upload-menu" aria-expanded="false">+</button><div contenteditable="true" role="textbox" class="ql-editor"></div><button type="button" id="send" aria-label="Send message">Send</button></form><script>
      const accountControl=document.querySelector('[aria-label^="Google Account:"]');
      const accountLabel=accountControl.getAttribute('aria-label');accountControl.removeAttribute('aria-label');
      const promptEditor=document.querySelector('[contenteditable]');promptEditor.setAttribute('contenteditable','false');
      setTimeout(()=>{accountControl.setAttribute('aria-label',accountLabel);promptEditor.setAttribute('contenteditable','true');window.fixtureReadyAt=Date.now();},${++hydrations === 1 ? 9000 : 600});
      function wire(){for(const b of document.querySelectorAll('[data-download]')){b.onmouseenter=()=>{if(b.dataset.rebound)return;b.dataset.rebound='yes';const clone=b.cloneNode(true);clone.style.marginLeft='24px';b.replaceWith(clone);wire();};b.onclick=async(event)=>{if(!event.isTrusted || !navigator.userActivation.isActive)return;const prepared=await(await fetch('/prepare?file='+encodeURIComponent(b.dataset.download))).json();const frame=document.createElement('iframe');frame.src=prepared.url;document.body.append(frame);};}}
      const unrelated=document.createElement('input');unrelated.type='file';unrelated.accept='audio/*';unrelated.hidden=true;document.body.append(unrelated);
      document.querySelector('#upload-menu').onclick=()=>{
        const opener=document.querySelector('#upload-menu');opener.setAttribute('aria-expanded','true');
        const menu=document.createElement('div');menu.setAttribute('role','menu');
        const item=document.createElement('div');item.setAttribute('role','menuitem');item.setAttribute('aria-label','Upload files');item.textContent='Upload files';menu.append(item);document.body.append(menu);
        item.onclick=()=>{
          menu.remove();const input=document.createElement('input');input.type='file';input.accept='image/*,.pdf';input.multiple=true;input.hidden=true;input.dataset.fixtureReference='true';document.querySelector('form').append(input);
          input.onchange=(event)=>{
        window.fixtureUploadAt=Date.now();const attachments=document.querySelector('#attachments');attachments.setAttribute('aria-busy','true');attachments.textContent='Uploading';
        setTimeout(()=>{attachments.textContent=[...event.target.files].map(file=>file.name).join(' ');attachments.removeAttribute('aria-busy');},200);
          };
        };
      };
      wire();document.querySelector('#send').onclick=async()=>{
        if(document.querySelector('#attachments').getAttribute('aria-busy')==='true')throw Error('Sent before upload completion');
        const references=await Promise.all([...(document.querySelector('[data-fixture-reference]')?.files || [])].map(async(file)=>({name:file.name,bytes:[...new Uint8Array(await file.arrayBuffer())]})));
        const editor=document.querySelector('[contenteditable]'),prompt=editor.textContent;document.querySelector('#send').disabled=true;
        for(const old of document.querySelectorAll('model-response'))old.replaceWith(old.cloneNode(true));
        const query=document.createElement('user-query');query.textContent=prompt;document.querySelector('#responses').append(query);
        const response=document.createElement('model-response');response.setAttribute('aria-busy','true');response.textContent='Generating';document.querySelector('#responses').append(response);
        const stop=document.createElement('button');stop.setAttribute('aria-label','Stop response');stop.textContent='Stop';document.body.append(stop);
        const data=await(await fetch('/mock/generate',{method:'POST',body:JSON.stringify({prompt,references,uploadWaitMs:window.fixtureUploadAt-window.fixtureReadyAt,chatId:location.pathname.split('/')[2]||null})})).json();
        history.replaceState({},'', '/app/'+data.id);
        setTimeout(()=>{response.innerHTML=data.html;response.removeAttribute('aria-busy');stop.remove();document.querySelector('#send').disabled=false;editor.textContent='';document.querySelector('#attachments').textContent='';if(document.querySelector('[data-fixture-reference]'))document.querySelector('[data-fixture-reference]').value='';wire();},data.delay);
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
      generationTimeoutMs: 25000,
      generationReadyTimeoutMs: 12000,
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
      releaseAcks();
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
      await page.locator("#generation-references").setInputFiles({
        name: "dashboard-logo.png",
        mimeType: "image/png",
        buffer: png(17),
      });
      assert.equal(await page.locator("#reference-previews img").count(), 1);
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
      const stateBeforeAck = await (
        await request("/api/generation/jobs/" + first.id)
      ).json();
      assert.equal(stateBeforeAck.state, "completed");
      assert.equal(stateBeforeAck.browserCleanupPending, true);
      assert.equal(service.generation.busy, true);
      assert.ok(backgroundTarget);
      const visibility = await originalSend.call(
        service.browser.pipe,
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        service.browser.gemini.session,
      );
      assert.equal(
        visibility.result.value,
        "hidden",
        "Gemini must remain in the background through file publication",
      );
      const stored = JSON.parse(
        await fs.readFile(service.generation.file, "utf8"),
      );
      assert.equal(
        stored.jobs.find((job) => job.id === first.id).state,
        "completed",
      );
      releaseAcks();
      await until(() => !service.generation.busy);
      await originalSend.call(service.browser.pipe, "Target.closeTarget", {
        targetId: backgroundTarget,
      });

      config.generationReadyTimeoutMs = 3000;
      service.browser.options.pageSettleMs = 0;
      config.generationTimeoutMs = 15000;
      assert.deepEqual(downloads, ["/img/1-0.png"]);
      assert.ok(
        uploadWaits[0] >= 5000,
        "References were uploaded before the five-second post-load wait",
      );
      assert.deepEqual(Buffer.from(receivedReferences[0][0].bytes), png(17));
      const firstMetadata = await (
        await request("/api/generation/jobs/" + first.id + "/metadata")
      ).json();
      assert.deepEqual(firstMetadata.inputAssetNames, ["dashboard-logo.png"]);
      assert.ok(
        service.log
          .snapshot()
          .entries.some((event) => event.code === "IMAGE_DOWNLOAD_PREPARING"),
      );
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
      await page.locator("#result-filter").selectOption("attention");
      const beforeImport = posts;
      const jobCard = page.locator(`[data-job-id="${broken.id}"]`);
      await jobCard
        .getByRole("button", { name: "Attach downloaded image" })
        .waitFor();
      page.once("dialog", (dialog) => dialog.accept());
      await jobCard.locator('input[type="file"]').setInputFiles({
        name: "822ce7ee-b783-4114-9777-e23d9fb5d985",
        mimeType: "application/octet-stream",
        buffer: png(100),
      });
      await until(
        () => service.generation.get(broken.id).state === "completed",
      );
      assert.equal(posts, beforeImport);
      const imported = await (
        await request("/api/generation/jobs/" + broken.id + "/metadata")
      ).json();
      assert.equal(imported.retrievalMode, "manual_import");
      assert.equal(imported.associationVerified, false);
      await page.locator("#result-filter").selectOption("completed");
      await page
        .getByText(
          "Manually attached · association confirmed by user, not automatically verified.",
        )
        .waitFor();
      // Exercise the public bearer API with the real runner, not a mocked queue.
      await until(() => !service.generation.busy);
      const apiClient = await createClient(data, "Browser fixture API");
      const apiHeaders = {
        Authorization: "Bearer " + apiClient.token,
        "Idempotency-Key": "browser-api-generation-0001",
      };
      const apiForm = new FormData();
      apiForm.set("prompt", "API image generation");
      apiForm.append(
        "references",
        new Blob([png(19)], { type: "image/png" }),
        "api-logo.png",
      );
      apiForm.append(
        "references",
        new Blob([png(21)], { type: "image/png" }),
        "api-reference.png",
      );
      const accepted = await fetch(base + "/api/v1/generations", {
        method: "POST",
        headers: apiHeaders,
        body: apiForm,
      });
      assert.equal(accepted.status, 202);
      const apiJob = await accepted.json();
      assert.equal((await final(apiJob.id)).state, "completed");
      const status = await (
        await fetch(base + "/api/v1/generations/" + apiJob.id, {
          headers: apiHeaders,
        })
      ).json();
      assert.equal(status.state, "completed");
      assert.ok(status.chatId);
      assert.deepEqual(
        Buffer.from(receivedReferences.at(-1)[0].bytes),
        png(19),
      );
      assert.deepEqual(
        Buffer.from(receivedReferences.at(-1)[1].bytes),
        png(21),
      );
      const apiMetadata = await (
        await fetch(base + "/api/v1/generations/" + apiJob.id + "/metadata", {
          headers: apiHeaders,
        })
      ).json();
      assert.deepEqual(apiMetadata.inputAssetNames, [
        "api-logo.png",
        "api-reference.png",
      ]);
      const output = await fetch(
        base + "/api/v1/generations/" + apiJob.id + "/image",
        { headers: apiHeaders },
      );
      assert.equal(output.status, 200);
      assert.ok(
        Buffer.from(await output.arrayBuffer()).equals(png(posts * 20)),
      );
      await page
        .locator("#api-log-rows")
        .getByText(apiJob.id, { exact: true })
        .first()
        .waitFor();
    } catch (error) {
      releaseAcks();
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
