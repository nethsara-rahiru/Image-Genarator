import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  createClient,
  readClients,
  revokeClient,
  rotateClient,
} from "../src/apiClients.js";
import { configuration } from "../src/config.js";
import { startServer } from "../src/server.js";
import { imageInfo } from "../src/generation/imageInfo.js";
import { png } from "./fixtures/png.js";
test("API clients use revocable scoped bearer keys, own outputs and isolated idempotency", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "client-api-"));
  const a = await createClient(data, "Client A", [
    "read",
    "generate",
    "browser",
  ]);
  const b = await createClient(data, "Client B");
  const read = await createClient(data, "Read only", ["read"]);
  assert.ok(
    !(
      await fs.readFile(path.join(data, "api-clients/clients.json"), "utf8")
    ).includes(a.token),
  );
  let calls = 0;
  const service = await startServer(
    { ...configuration({ DATA_DIR: data }), port: 0 },
    {
      test: true,
      generationRunner: {
        async run(job, context) {
          calls++;
          await context.phase("submitting_prompt", {
            submissionPossible: true,
            accountKey: "account-a",
          });
          await context.chat(
            "chat-" + job.id,
            "https://gemini.google.com/app/chat-" + job.id,
            "account-a",
          );
          await fs.mkdir(context.directory, { recursive: true });
          await fs.writeFile(path.join(context.directory, "image.png"), png());
          return { ...imageInfo(png()), filename: "image.png" };
        },
      },
    },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.port}`;
  service.config.origin = base;
  const host = new URL(base).host;
  const request = (route, key = a.token, method = "GET", body, extra = {}) =>
    fetch(base + route, {
      method,
      headers: {
        Host: host,
        ...(key ? { Authorization: "Bearer " + key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await request("/api/v1/health", null)).status, 401);
  assert.equal((await request("/api/v1/health", "bad-key")).status, 401);
  assert.equal((await request("/api/v1/health")).status, 200);
  assert.equal(
    (
      await request("/api/v1/health", a.token, "GET", null, {
        Origin: "https://wrong.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/v1/browser/start", read.token, "POST")).status,
    403,
  );
  assert.equal(
    (
      await request("/api/v1/generations", read.token, "POST", {
        prompt: "image",
      })
    ).status,
    403,
  );
  const commands = [];
  service.browser.action = async (d) => {
    commands.push(d);
  };
  assert.equal(
    (await request("/api/v1/browser/start", a.token, "POST")).status,
    200,
  );
  assert.equal(commands[0].type, "start");
  assert.equal(commands[0].automation, true);
  assert.equal(
    (await request("/api/v1/browser/stop", a.token, "POST")).status,
    200,
  );
  // Bearer credentials do not exempt dashboard mutations from CSRF.
  assert.equal(
    (await request("/api/action", a.token, "POST", { type: "start" })).status,
    403,
  );
  const missingKey = await request("/api/v1/generations", a.token, "POST", {
    prompt: "image",
  });
  assert.equal(missingKey.status, 400);
  assert.equal(
    (await missingKey.json()).code,
    "GENERATION_IDEMPOTENCY_KEY_REQUIRED",
  );
  assert.ok(missingKey.headers.get("x-request-id"));
  const misspelled = await request(
    "/api/v1/genarations?secret=hidden",
    a.token,
    "POST",
    { prompt: "secret prompt" },
  );
  assert.equal(misspelled.status, 404);
  assert.match((await misspelled.json()).error, /POST \/api\/v1\/generations/);
  const submit = (key) =>
    request(
      "/api/v1/generations",
      key,
      "POST",
      { prompt: "image" },
      { "Idempotency-Key": "same-request-key" },
    );
  const response = await submit(a.token);
  assert.equal(response.status, 202);
  const first = await response.json();
  const apiLogs = service.log
    .snapshot()
    .entries.filter((entry) => entry.source === "api");
  assert.ok(apiLogs.some((entry) => entry.details.status === 401));
  assert.ok(
    apiLogs.some(
      (entry) =>
        entry.details.status === 400 &&
        entry.details.endpoint === "/api/v1/generations",
    ),
  );
  assert.ok(
    apiLogs.some(
      (entry) =>
        entry.details.status === 202 && entry.details.jobId === first.id,
    ),
  );
  assert.doesNotMatch(JSON.stringify(apiLogs), /secret prompt|secret=hidden/);
  assert.ok(!JSON.stringify(apiLogs).includes(a.token));
  assert.equal((await (await submit(a.token)).json()).id, first.id);
  const second = await (await submit(b.token)).json();
  assert.notEqual(first.id, second.id);
  for (
    let n = 0;
    n < 100 && service.generation.get(second.id).state !== "completed";
    n++
  )
    await pause(20);
  assert.equal(calls, 2);
  assert.equal(
    (await request(`/api/v1/generations/${first.id}`, b.token)).status,
    404,
  );
  assert.equal(
    (await request(`/api/v1/generations/${first.id}/image`, b.token)).status,
    404,
  );
  assert.equal(
    (await request(`/api/v1/generations/${first.id}/cancel`, b.token, "POST"))
      .status,
    404,
  );
  const list = await (await request("/api/v1/generations", b.token)).json();
  assert.equal(list.total, 1);
  assert.equal(list.jobs[0].id, second.id);
  const chats = await (await request("/api/v1/chats", b.token)).json();
  assert.equal(chats.chats.length, 1);
  assert.equal(
    (
      await request(
        "/api/v1/generations",
        b.token,
        "POST",
        { prompt: "image", chatId: service.generation.get(first.id).chatId },
        { "Idempotency-Key": "other-chat-key" },
      )
    ).status,
    404,
  );
  const image = await request(`/api/v1/generations/${first.id}/image`);
  assert.equal(image.status, 200);
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(png()));
  const metadata = await (
    await request(`/api/v1/generations/${first.id}/metadata`)
  ).json();
  assert.equal(metadata.jobId, first.id);
  const referenceForm = () => {
    const form = new FormData();
    form.set("prompt", "Use this reference");
    form.append(
      "references",
      new Blob([png(33)], { type: "application/octet-stream" }),
      "logo-without-extension",
    );
    return form;
  };
  const multipart = (body, key = "reference-api-request", client = a.token) =>
    fetch(base + "/api/v1/generations", {
      method: "POST",
      headers: { Authorization: "Bearer " + client, "Idempotency-Key": key },
      body,
    });
  const uploaded = await multipart(referenceForm());
  assert.equal(uploaded.status, 202);
  const referencedJob = await uploaded.json();
  assert.equal(
    (await (await multipart(referenceForm())).json()).id,
    referencedJob.id,
  );
  const storedReference = service.generation.get(referencedJob.id)
    .references[0];
  assert.deepEqual(
    await fs.readFile(
      path.join(
        service.generation.outputs,
        referencedJob.id,
        "inputs",
        storedReference.filename,
      ),
    ),
    png(33),
  );
  for (
    let n = 0;
    n < 100 && service.generation.get(referencedJob.id).state !== "completed";
    n++
  )
    await pause(20);
  const referenceMetadata = await (
    await request(`/api/v1/generations/${referencedJob.id}/metadata`)
  ).json();
  assert.deepEqual(referenceMetadata.inputAssetNames, [
    "logo-without-extension",
  ]);
  assert.equal(
    (await multipart(referenceForm(), "scope-reference-key", read.token))
      .status,
    403,
  );
  const invalid = new FormData();
  invalid.set("prompt", "bad reference");
  invalid.append(
    "references",
    new Blob(["<svg>unsafe</svg>"], { type: "image/png" }),
    "fake.png",
  );
  assert.equal((await multipart(invalid, "invalid-reference-key")).status, 400);
  const tooMany = referenceForm();
  for (let i = 0; i < 4; i++)
    tooMany.append("references", new Blob([png()]), "image.png");
  assert.equal(
    (await multipart(tooMany, "too-many-reference-key")).status,
    400,
  );
  const oversized = new FormData();
  oversized.set("prompt", "large reference");
  oversized.append(
    "references",
    new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]),
    "large.png",
  );
  assert.equal(
    (await multipart(oversized, "oversized-reference-key")).status,
    413,
  );
  assert.equal((await request("/api/v1/generations?limit=999")).status, 400);
  assert.equal((await request("/api/v1/unknown")).status, 404);
  const oldToken = a.token;
  const rotated = await rotateClient(data, a.id);
  assert.equal(rotated.id, a.id);
  assert.equal((await request("/api/v1/health", oldToken)).status, 401);
  a.token = rotated.token;
  assert.equal(
    (await request(`/api/v1/generations/${first.id}`, a.token)).status,
    200,
  );
  await revokeClient(data, a.id);
  assert.equal((await request("/api/v1/health")).status, 401);
  const rows = await readClients(data);
  rows.find((client) => client.id === b.id).expiresAt = new Date(
    0,
  ).toISOString();
  await fs.writeFile(
    path.join(data, "api-clients/clients.json"),
    JSON.stringify(rows),
  );
  assert.equal((await request("/api/v1/health", b.token)).status, 401);
  for (let n = 0; n < 120; n++) await request("/api/v1/health", read.token);
  assert.equal((await request("/api/v1/health", read.token)).status, 429);
});

test("public API requires HTTPS transport and does not unlock the protected dashboard", async (t) => {
  const { default: http } = await import("node:http");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "public-api-"));
  const key = await createClient(data, "HTTPS client", ["read"]);
  const service = await startServer(
    {
      ...configuration({
        DATA_DIR: data,
        AUTH_REQUIRED: "true",
        PUBLIC_ORIGIN: "https://images.example.test",
      }),
      port: 0,
    },
    { test: true },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  const request = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: service.port,
          path: url,
          headers: {
            Host: "images.example.test",
            "X-Forwarded-Proto": "https",
            Authorization: "Bearer " + key.token,
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal(await request("/api/v1/health"), 200);
  assert.equal(
    await request("/api/v1/health", { "X-Forwarded-Proto": "http" }),
    403,
  );
  assert.equal(
    await request("/api/v1/health", { Host: "wrong.example.test" }),
    403,
  );
  assert.equal(await request("/api/generation"), 401);
});
