const router = require("express").Router();
const mongoose = require("mongoose");
const Run = require("../models/PromotionRun");
const Profile = require("../models/Profile");
const Product = require("../models/Product");
const validImage = require("../utils/productImage");
const { requireAuth } = require("../middleware/auth");
const { config, fingerprint } = require("../services/promotionConfig");
const { bucket } = require("../services/promotionImages");
const { active } = require("../services/promotionWorker");
router.use(requireAuth, (req, res, next) =>
  req.user.role === "owner"
    ? next()
    : res
        .status(403)
        .json({ error: "Only business owners can create promotions." }),
);
function pub(run) {
  return {
    id: String(run._id),
    targetType: run.targetType,
    targetName: run.targetName,
    state: run.state,
    completed: run.items.filter((i) => i.completedAt).length,
    total: 4,
    current: Math.min(run.current + 1, 4),
    error: run.error?.code ? run.error : null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    items: run.items.map((item, index) => ({
      index: index + 1,
      prompt: item.prompt,
      remoteJobId: item.remoteJobId,
      remoteState: item.remoteState,
      chatId: item.chatId,
      chatUrl: item.chatUrl,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      contentType: item.contentType,
      checksum: item.checksum,
      completedAt: item.completedAt,
      imageUrl: item.completedAt
        ? `/api/promotions/${run._id}/images/${index + 1}`
        : null,
    })),
  };
}
async function owned(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Run.findOne({ _id: req.params.id, owner: req.user._id });
}
router.post("/", async (req, res) => {
  const { targetType, productId } = req.body || {},
    key = req.get("Idempotency-Key");
  if (
    !["business", "product"].includes(targetType) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(key || "") ||
    (targetType === "product" && !mongoose.isValidObjectId(productId))
  )
    return res.status(400).json({
      error:
        "Choose business or product (with productId) and send an Idempotency-Key of 8–128 letters, numbers, underscores or dashes.",
    });
  const replay = (run) => {
    if (
      run.targetType !== targetType ||
      String(run.product || "") !==
        (targetType === "product" ? String(productId) : "")
    )
      return res.status(409).json({
        error: "Idempotency key was already used for another target.",
      });
    return res.status(202).json({ promotion: pub(run) });
  };
  const existing = await Run.findOne({ owner: req.user._id, key });
  if (existing) return replay(existing);
  let settings;
  try {
    settings = config();
  } catch (error) {
    return res
      .status(503)
      .json({
        error: error.message,
        code:
          error.code === "PROMOTION_TLS_CONFIG"
            ? error.code
            : "PROMOTION_CONFIG",
      });
  }
  if (
    (await Run.countDocuments({
      owner: req.user._id,
      state: { $in: active },
    })) >= 5
  )
    return res.status(429).json({
      error:
        "Five promotions are already pending. Wait or cancel one before starting another.",
    });
  const profile = await Profile.findOne({ owner: req.user._id }).lean();
  if (!profile)
    return res
      .status(422)
      .json({ error: "Set up your business profile first." });
  let product;
  if (targetType === "product") {
    product = await Product.findOne({
      _id: productId,
      owner: req.user._id,
    }).lean();
    if (!product) return res.status(404).json({ error: "Product not found." });
    if (!validImage(product.image))
      return res
        .status(422)
        .json({ error: "Upload a valid product reference image first." });
  }
  const references = [
    ...new Set([product?.image, profile.logo].filter(validImage)),
  ];
  if (!references.length)
    return res.status(422).json({
      error:
        "Upload a PNG, JPEG or WebP business logo before promoting your business.",
    });
  const prefs = req.user.toObject().preferences || {};
  const data = {
    owner: req.user._id,
    key,
    targetType,
    product: product?._id || null,
    provider: fingerprint(settings),
    targetName: product?.name || profile.name,
    references,
    context: {
      business: {
        name: profile.name,
        description: profile.description,
        category: profile.category,
        city: profile.city,
      },
      product: product
        ? { name: product.name, description: product.description }
        : null,
      preferences: prefs,
      referenceOrder: product
        ? [
            "product image",
            ...(validImage(profile.logo) && profile.logo !== product.image
              ? ["business logo"]
              : []),
          ]
        : ["business logo"],
    },
    items: Array.from({ length: 4 }, () => ({
      imageId: new mongoose.Types.ObjectId(),
    })),
  };
  let run;
  try {
    run = await Run.create(data);
  } catch (error) {
    if (error.code !== 11000) throw error;
    return replay(await Run.findOne({ owner: req.user._id, key }));
  }
  res
    .status(202)
    .location(`/api/promotions/${run._id}`)
    .json({ promotion: pub(run) });
});
router.get("/", async (req, res) => {
  const limit = Number(req.query.limit || 10),
    offset = Number(req.query.offset || 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    return res
      .status(400)
      .json({ error: "Use limit 1–50 and nonnegative offset." });
  const filter = { owner: req.user._id };
  const [runs, total] = await Promise.all([
    Run.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit),
    Run.countDocuments(filter),
  ]);
  res.json({ promotions: runs.map(pub), total, limit, offset });
});
router.get("/:id", async (req, res) => {
  const run = await owned(req);
  if (!run) return res.status(404).json({ error: "Promotion not found." });
  res.json({ promotion: pub(run) });
});
router.post("/:id/cancel", async (req, res) => {
  const run = await owned(req);
  if (!run) return res.status(404).json({ error: "Promotion not found." });
  await Run.updateOne(
    { _id: run._id, owner: req.user._id, state: { $in: active } },
    { $set: { state: "cancelled", completedAt: new Date() } },
  );
  res.json({ promotion: pub(await owned(req)) });
});
router.get("/:id/images/:index", async (req, res, next) => {
  const run = await owned(req),
    index = Number(req.params.index);
  if (
    !run ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > 4 ||
    !run.items[index - 1]?.completedAt
  )
    return res.status(404).json({ error: "Saved image not found." });
  const item = run.items[index - 1];
  const file = await bucket()
    .find({
      _id: item.imageId,
      "metadata.owner": String(req.user._id),
      "metadata.run": String(run._id),
    })
    .next();
  if (!file) return res.status(404).json({ error: "Saved image not found." });
  res.set({
    "Content-Type": item.contentType,
    "Content-Length": String(item.bytes),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="promotion-${run._id}-${index}.${item.contentType === "image/jpeg" ? "jpg" : item.contentType.split("/")[1]}"`,
  });
  const stream = bucket().openDownloadStream(item.imageId);
  res.on("close", () => stream.destroy());
  stream.on("error", (error) =>
    res.headersSent ? res.destroy() : next(error),
  );
  stream.pipe(res);
});
module.exports = router;
