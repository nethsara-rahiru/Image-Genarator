import express from "express";
import { actionError } from "./actionErrors.js";
export function clientApi({ browser, generation, flow, action }) {
  const router = express.Router();
  const scope = (name) => (req, res, next) =>
    req.apiClient.scopes.includes(name)
      ? next()
      : res.status(403).json({ error: `API scope required: ${name}` });
  const owns = (req, id) => {
    const job = generation.data.jobs.find(
      (job) => job.id === id && job.apiClientId === req.apiClient.id,
    );
    if (!job) {
      const error = new Error("Job not found");
      error.status = 404;
      throw error;
    }
    return job;
  };
  const jobs = (req) =>
    generation.data.jobs.filter((job) => job.apiClientId === req.apiClient.id);
  router.get("/health", scope("read"), (req, res) =>
    res.json({ status: "ok", queueBusy: generation.busy }),
  );
  router.get("/browser/status", scope("read"), async (req, res) =>
    res.json({ ...(await browser.state()), queueBusy: generation.busy }),
  );
  for (const operation of ["start", "stop"])
    router.post("/browser/" + operation, scope("browser"), async (req, res) => {
      if (flow.snapshot().active)
        return res.status(409).json({ error: "Finish manual sign-in first" });
      await action(
        {
          type: operation,
          ...(operation === "start" ? { automation: true } : {}),
        },
        req,
      );
      res.json(await browser.state());
    });
  router.post("/browser/gemini", scope("browser"), async (req, res) => {
    if (flow.snapshot().active)
      return res.status(409).json({ error: "Finish manual sign-in first" });
    await action({ type: "start", automation: true }, req);
    await action({ type: "automation", command: "open", site: "gemini" }, req);
    res.json({
      ...(await browser.state()),
      message: "Gemini opened. Sign in manually in Chrome if needed.",
    });
  });
  router.get("/chats", scope("read"), (req, res) => {
    const ids = new Set(jobs(req).map((job) => job.chatId));
    res.json({
      chats: generation.snapshot().chats.filter((chat) => ids.has(chat.id)),
    });
  });
  router.get("/generations", scope("read"), (req, res) => {
    const limit = Number(req.query.limit || 20),
      offset = Number(req.query.offset || 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      return res
        .status(400)
        .json({ error: "Use limit 1–100 and nonnegative offset" });
    const rows = jobs(req).slice().reverse();
    res.json({
      total: rows.length,
      limit,
      offset,
      jobs: rows
        .slice(offset, offset + limit)
        .map((job) => generation.publicJob(job)),
    });
  });
  router.post("/generations", scope("generate"), async (req, res) => {
    if (flow.snapshot().active)
      return res.status(409).json({ error: "Finish manual sign-in first" });
    const { prompt, chatId = null } = req.body || {};
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(req.headers["idempotency-key"] || ""))
      return res.status(400).json({
        code: "GENERATION_IDEMPOTENCY_KEY_REQUIRED",
        error:
          "Set the Idempotency-Key header to 8–128 letters, digits, underscores or dashes. Use a new key for each new generation; reuse it only to safely repeat the same request.",
      });
    if (chatId && !jobs(req).some((job) => job.chatId === chatId))
      return res
        .status(404)
        .json({ error: "Chat not found for this API client" });
    const job = await generation.create(
      { prompt, chatId, idempotencyKey: req.headers["idempotency-key"] },
      req.apiClient.id,
    );
    res.locals.apiJobId = job.id;
    res.status(202).location(`/api/v1/generations/${job.id}`).json(job);
  });
  router.get("/generations/:id", scope("read"), (req, res) => {
    const job = owns(req, req.params.id);
    res.locals.apiJobId = job.id;
    res.json(generation.publicJob(job));
  });
  for (const operation of ["cancel", "retry", "recover"])
    router.post(
      "/generations/:id/" + operation,
      scope("generate"),
      async (req, res) => {
        owns(req, req.params.id);
        if (operation !== "cancel" && flow.snapshot().active)
          return res.status(409).json({ error: "Finish manual sign-in first" });
        res.json(await generation[operation](req.params.id));
      },
    );
  for (const kind of ["image", "metadata"])
    router.get("/generations/:id/" + kind, scope("read"), async (req, res) => {
      const job = owns(req, req.params.id);
      if (job.state !== "completed")
        return res
          .status(409)
          .json({ error: "Output is not completed", state: job.state });
      const file = await generation.outputFile(job.id, kind === "metadata");
      if (kind === "image")
        res
          .type(job.output.contentType)
          .download(file.path, job.id + "." + job.output.format);
      else res.type("application/json").sendFile(file.path);
    });
  router.use((req, res) =>
    res.status(404).json({
      error:
        "API endpoint not found. To generate an image, POST /api/v1/generations with a JSON prompt and Idempotency-Key header.",
    }),
  );
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const diagnosed = actionError(error);
    res
      .status(
        error.status || (diagnosed.code === "GENERATION_BUSY" ? 409 : 400),
      )
      .json(
        error.status === 404
          ? { error: "Job not found" }
          : { error: diagnosed.message, code: diagnosed.code },
      );
  });
  return router;
}
