import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareReferences } from "../src/generation/references.js";
import { configuration } from "../src/config.js";
import { GenerationQueue } from "../src/generation/queue.js";
import { png } from "./fixtures/png.js";
import { GenerationRunner } from "../src/generation/runner.js";

test("references sniff bytes, bound size/count, sanitize names and randomize storage", () => {
  const [ref] = prepareReferences([
    { originalname: "../../logo.png", buffer: png() },
  ]);
  assert.equal(ref.contentType, "image/png");
  assert.match(ref.filename, /^reference-1-[a-f0-9]{8}\.png$/);
  assert.ok(!ref.name.includes("/"));
  assert.notEqual(
    prepareReferences([{ buffer: png() }])[0].filename,
    ref.filename,
  );
  assert.throws(() =>
    prepareReferences([
      { buffer: Buffer.from("<svg>unsafe</svg>"), mimetype: "image/png" },
    ]),
  );
  assert.throws(() =>
    prepareReferences([{ buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }]),
  );
  assert.throws(() =>
    prepareReferences(Array.from({ length: 5 }, () => ({ buffer: png() }))),
  );
});

test("reference inputs persist with a queued job, affect idempotency and are removed with it", async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "references-"));
  const queue = new GenerationQueue(configuration({ DATA_DIR: data }), {});
  await queue.init();
  queue.stopping = true;
  t.after(async () => {
    await queue.close();
    await fs.rm(data, { recursive: true, force: true });
  });
  const input = {
    prompt: "Use this logo",
    idempotencyKey: "reference-request-1",
    referenceImages: [{ originalname: "logo.png", buffer: png() }],
  };
  const first = await queue.create(input);
  assert.equal((await queue.create(input)).id, first.id);
  const file = path.join(
    queue.outputs,
    first.id,
    "inputs",
    first.references[0].filename,
  );
  assert.deepEqual(await fs.readFile(file), png());
  assert.ok(!JSON.stringify(queue.data).includes('"buffer"'));
  const sent = [];
  const runner = new GenerationRunner({
    gemini: { session: "fixture" },
    pipe: {
      async send(method, params) {
        sent.push({ method, params });
        return method === "DOM.getDocument"
          ? { root: { nodeId: 1 } }
          : { nodeId: 2 };
      },
    },
  });
  runner.evaluate = async ({ operation }) => ({
    ok: operation === "prepare_attachments",
  });
  await assert.rejects(
    runner.uploadReferences(
      queue.get(first.id),
      path.dirname(path.dirname(file)),
      AbortSignal.timeout(20),
      "account",
    ),
  );
  assert.ok(sent.some(({ method }) => method === "DOM.setFileInputFiles"));
  assert.ok(!sent.some(({ method }) => /click|send_prompt/i.test(method)));
  runner.evaluate = async () => ({ ok: true });
  await runner.uploadReferences(
    queue.get(first.id),
    path.dirname(path.dirname(file)),
    AbortSignal.timeout(1000),
    "account",
  );
  const original = await fs.readFile(file);
  await fs.writeFile(file, png(91));
  await assert.rejects(
    runner.uploadReferences(
      queue.get(first.id),
      path.dirname(path.dirname(file)),
      AbortSignal.timeout(1000),
      "account",
    ),
    { code: "GENERATION_REFERENCES" },
  );
  await fs.writeFile(file, original);
  await assert.rejects(
    queue.create({
      ...input,
      referenceImages: [{ originalname: "logo.png", buffer: png(81) }],
    }),
    { code: "GENERATION_CONFLICT" },
  );
  await assert.rejects(queue.create({ ...input, referenceImages: [] }), {
    code: "GENERATION_CONFLICT",
  });
  queue.get(first.id).state = "cancelled";
  await queue.remove(first.id);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
