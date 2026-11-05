const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const Run = require("../models/PromotionRun");
const { config, fail, fingerprint } = require("./promotionConfig");
const { clients } = require("./promotionClients");
const { store } = require("./promotionImages");
const active = [
  "queued",
  "prompting",
  "submitting",
  "generating",
  "downloading",
];
function worker({
  getConfig = config,
  makeClients = clients,
  storeImage = store,
  intervalMs = 1000,
} = {}) {
  const holder = randomUUID();
  let timer,
    busy = false,
    stopping = false,
    controller,
    heartbeat,
    leaseUntil = 0;
  const leases = () => mongoose.connection.db.collection("promotionLeases");
  async function acquire() {
    const expires = new Date(Date.now() + 60000);
    try {
      const result = await leases().findOneAndUpdate(
        { _id: "global", $or: [{ expires: { $lte: new Date() } }, { holder }] },
        { $set: { holder, expires } },
        { upsert: true, returnDocument: "after" },
      );
      if (result?.holder !== holder) return false;
      leaseUntil = expires.getTime();
      return true;
    } catch (error) {
      if (error.code === 11000) return false;
      throw error;
    }
  }
  async function processRun(run) {
    const c = getConfig(),
      api = makeClients(c, controller.signal);
    try {
      return await processImages(run, c, api);
    } finally {
      await api.close?.();
    }
  }
  async function processImages(run, c, api) {
    if (run.provider !== fingerprint(c))
      throw fail(
        "PROMOTION_CONFIG",
        "Image API URL or token changed since this promotion was queued. Restore the previous configuration to inspect existing remote jobs; this run was stopped without resubmission.",
      );
    async function check() {
      if (controller.signal.aborted || Date.now() >= leaseUntil)
        throw fail(
          "WORKER_STOPPED",
          "Worker paused; this run will resume when the service is available.",
        );
      const current = await Run.findById(run._id).select("state").lean();
      if (!current || current.state === "cancelled")
        throw fail(
          "CANCELLED",
          "Promotion cancelled. A previously submitted remote job may still finish.",
        );
    }
    async function save(state) {
      await check();
      if (state) run.state = state;
      // A run may be cancelled while the remote request is in flight. Do not resurrect it.
      const saved = await Run.updateOne(
        { _id: run._id, worker: holder, state: { $in: active } },
        {
          $set: {
            state: run.state,
            items: run.items.map((i) => i.toObject()),
            current: run.current,
            startedAt: run.startedAt,
            deadline: run.deadline,
            completedAt: run.completedAt,
          },
        },
      );
      if (!saved.matchedCount) throw fail("CANCELLED", "Promotion cancelled.");
    }
    if (!run.startedAt) {
      run.startedAt = new Date();
      await save();
    }
    for (let i = run.current; i < 4; i++) {
      const item = run.items[i];
      if (item.completedAt) {
        run.current = i + 1;
        continue;
      }
      if (!run.deadline) {
        run.deadline = new Date(Date.now() + c.timeoutMs);
        await save();
      }
      const remaining = () => {
        if (Date.now() > run.deadline.getTime())
          throw fail(
            "PROMOTION_TIMEOUT",
            "This image exceeded the wait limit. Inspect the remote job; no new prompt will be submitted automatically.",
          );
      };
      await check();
      remaining();
      if (!item.prompt) {
        await save("prompting");
        item.prompt = await api.prompt(
          run.context,
          i,
          run.items.slice(0, i).map((s) => s.prompt),
        );
        await save();
      }
      if (!item.remoteJobId) {
        // Persist before submission. Crash recovery reuses this exact idempotency key,
        // prompt and reference snapshot, never a fresh generation request.
        if (c.autoStart && i === 0 && run.state !== "submitting") {
          await check();
          await api.start();
        }
        await save("submitting");
        remaining();
        const job = await api.submit(
          item.prompt,
          run.references,
          `promotion-${run._id}-${i + 1}`,
        );
        item.remoteJobId = job.id;
        await save("generating");
      }
      while (true) {
        await check();
        remaining();
        const job = await api.status(item.remoteJobId);
        if (job.id !== item.remoteJobId)
          throw fail(
            "UPSTREAM_RESPONSE",
            "Image service status did not match the requested job.",
          );
        item.remoteState = [
          "queued",
          "running",
          "preparing_prompt",
          "uploading_assets",
          "waiting_for_attachments",
          "submitting_prompt",
          "generating",
          "downloading",
          "completed",
          "failed",
          "cancelled",
          "needs_review",
          "needs_login",
        ].includes(job.state)
          ? job.state
          : "processing";
        if (
          ["failed", "cancelled", "needs_review", "needs_login"].includes(
            job.state,
          )
        ) {
          const code =
            job.state === "needs_login"
              ? "GENERATION_LOGIN_REQUIRED"
              : job.state === "needs_review"
                ? "GENERATION_NEEDS_REVIEW"
                : "GENERATION_FAILED";
          throw fail(
            code,
            job.state === "needs_login"
              ? "Sign in manually in the image generator's Chrome window. Completed images are kept. Start a new promotion only after resolving sign-in."
              : "Image generation stopped. Inspect the remote job in the image generator. Completed images are kept; no automatic resubmission was made.",
          );
        }
        if (job.state === "completed") {
          item.chatId =
            typeof job.chatId === "string" ? job.chatId.slice(0, 200) : "";
          item.chatUrl =
            typeof job.chatUrl === "string" &&
            /^https:\/\/gemini\.google\.com\/app\/[A-Za-z0-9_-]+$/.test(
              job.chatUrl,
            )
              ? job.chatUrl
              : "";
          await save("downloading");
          remaining();
          const bytes = await api.download(item.remoteJobId);
          await check();
          remaining();
          Object.assign(item, await storeImage(run, i, bytes));
          run.current = i + 1;
          run.deadline = null;
          if (i === 3) run.completedAt = new Date();
          await save(i === 3 ? "completed" : "prompting");
          break;
        }
        await save("generating");
        await new Promise((resolve) => {
          const stop = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            controller.signal.removeEventListener("abort", stop);
            resolve();
          }, c.pollMs);
          controller.signal.addEventListener("abort", stop, { once: true });
        });
      }
    }
    run.completedAt = new Date();
    // The fourth image has already transitioned to completed.
    await Run.updateOne(
      { _id: run._id, worker: holder, state: "completed" },
      { $set: { completedAt: run.completedAt } },
    );
  }

  async function tick() {
    if (busy || stopping || mongoose.connection.readyState !== 1) return;
    busy = true;
    let run,
      acquired = false;
    try {
      acquired = await acquire();
      if (!acquired) return;
      controller = new AbortController();
      const leaseController = controller;
      heartbeat = setInterval(async () => {
        try {
          const expires = new Date(Date.now() + 60000);
          const result = await leases().updateOne(
            { _id: "global", holder, expires: { $gt: new Date() } },
            { $set: { expires } },
          );
          if (!result.matchedCount) leaseController.abort();
          else if (controller === leaseController)
            leaseUntil = expires.getTime();
        } catch {
          leaseController.abort();
        }
      }, 10000);
      run = await Run.findOneAndUpdate(
        { state: { $in: active } },
        { $set: { worker: holder } },
        { new: true, sort: { createdAt: 1, _id: 1 } },
      ).select("+references +provider");
      if (run) await processRun(run);
    } catch (error) {
      if (
        run &&
        !controller?.signal.aborted &&
        Date.now() < leaseUntil &&
        error.code !== "CANCELLED"
      ) {
        const state =
          error.code === "GENERATION_LOGIN_REQUIRED"
            ? "needs_login"
            : run.state === "submitting" || run.items[run.current]?.remoteJobId
              ? "needs_review"
              : "failed";
        const safe = [
          "PROMOTION_CONFIG",
          "PROMOTION_TLS_CONFIG",
          "UPSTREAM_TLS",
          "GROQ_PROMPT",
          "IMAGE_INVALID",
          "IMAGE_SIZE",
          "UPSTREAM_HTTP",
          "UPSTREAM_RESPONSE",
          "UPSTREAM_UNAVAILABLE",
          "GENERATION_LOGIN_REQUIRED",
          "GENERATION_NEEDS_REVIEW",
          "GENERATION_FAILED",
          "PROMOTION_TIMEOUT",
        ].includes(error.code);
        await Run.updateOne(
          { _id: run._id, worker: holder, state: { $in: active } },
          {
            $set: {
              state,
              error: {
                code: safe ? error.code : "PROMOTION_FAILED",
                message: safe
                  ? error.message
                  : "Promotion processing failed. Check database and service availability. Saved images are retained.",
              },
            },
          },
        ).catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
      if (acquired)
        await leases()
          .deleteOne({ _id: "global", holder })
          .catch(() => {});
      controller = null;
      busy = false;
    }
  }
  return {
    tick,
    start() {
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      controller?.abort();
      while (busy) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
module.exports = { worker, active };
