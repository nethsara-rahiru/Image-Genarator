import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { configuration } from "../../src/config/index.js";
import {
  connect,
  GoogleAccount,
  GenerationJob,
  GeneratedOutput,
} from "../../src/models/index.js";
import { enqueue } from "../../src/services/jobQueue.js";
import { safePath } from "../../src/utils/files.js";
test(
  "LIVE Google/Gemini generation — requires explicitly enabled VPS acceptance",
  { skip: process.env.RUN_LIVE_GEMINI !== "1", timeout: 1000000 },
  async () => {
    const config = configuration();
    assert.match(process.env.LIVE_ACCOUNT_ID || "", /^[a-f\d]{24}$/i);
    assert(
      process.env.LIVE_PROMPT?.trim(),
      "Set an explicit, non-sensitive LIVE_PROMPT",
    );
    await connect(config.MONGODB_URI);
    try {
      const account = await GoogleAccount.findById(process.env.LIVE_ACCOUNT_ID);
      assert(
        account && !account.disabled && account.state === "ready",
        "Connect and verify the Google account in dashboard first",
      );
      const j = await enqueue(
        {
          accountId: String(account._id),
          createNew: true,
          prompt: process.env.LIVE_PROMPT,
          assetIds: [],
        },
        `live-${crypto.randomUUID()}`,
      );
      let job;
      const deadline = Date.now() + 900000;
      while (Date.now() < deadline) {
        job = await GenerationJob.findById(j._id);
        if (
          [
            "completed",
            "failed",
            "needs_login",
            "needs_review",
            "cancelled",
          ].includes(job.state)
        )
          break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(
        job.state,
        "completed",
        `Live result: ${job.state}; ${job.error?.code || "timeout"}. Inspect job ${job._id} in dashboard.`,
      );
      const o = await GeneratedOutput.findById(job.outputId);
      assert(o.width > 0 && o.height > 0 && o.bytes > 0);
      assert.equal(
        (
          await fs.stat(
            safePath(path.join(config.DATA_DIR, "outputs"), o.filename),
          )
        ).size,
        o.bytes,
      );
      const metadata = JSON.parse(
        await fs.readFile(
          safePath(path.join(config.DATA_DIR, "outputs"), `${o.filename}.json`),
          "utf8",
        ),
      );
      assert.equal(metadata.jobId, String(j._id));
    } finally {
      await mongoose.disconnect();
    }
  },
);
