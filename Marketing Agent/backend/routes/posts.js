const router = require("express").Router();
const mongoose = require("mongoose");
const Post = require("../models/Post");
const Profile = require("../models/Profile");
const Product = require("../models/Product");
const { requireAuth } = require("../middleware/auth");

function ownerOnly(req, res, next) {
  if (req.user.role !== "owner")
    return res
      .status(403)
      .json({ error: "Only business owner accounts can manage posts." });
  next();
}
const pub = (p) => ({
  _id: p._id,
  text: p.text,
  platforms: p.platforms,
  status: p.status,
  createdAt: p.createdAt,
  targetType: p.targetType || "business",
  targetName: p.targetName || "",
  product: p.product || null,
  image: p.image || "",
});

// Simple template for now; AI generation can replace this later
function draftText(profile, prefs = {}) {
  const where = profile.city ? ` in ${profile.city}` : "";
  const d = profile.description;
  switch (prefs.tone) {
    case "professional":
      return `${profile.name}: ${d} Contact us to find out more.`;
    case "playful":
      return `Hey${profile.city ? " " + profile.city : ""}! ${profile.name} is here. ${d} Come say hi!`;
    case "luxury":
      return `${profile.name}. ${d} Crafted with care for those who appreciate the finer things.`;
    default:
      return `${profile.name} has something for you! ${d} Visit us${where} today.`;
  }
}

router.get("/posts", requireAuth, ownerOnly, async (req, res) => {
  const posts = await Post.find({ owner: req.user._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  res.json({ posts: posts.map(pub) });
});

router.post("/posts/draft", requireAuth, ownerOnly, async (req, res) => {
  const { targetType = "business", productId, text } = req.body || {};
  if (
    !["business", "product"].includes(targetType) ||
    (text !== undefined &&
      (typeof text !== "string" || !text.trim() || text.trim().length > 800))
  )
    return res.status(400).json({
      error:
        "Choose a valid promotion target and draft text of 1–800 characters.",
    });
  const profile = await Profile.findOne({ owner: req.user._id }).lean();
  if (!profile)
    return res
      .status(400)
      .json({ error: "Set up your business profile first." });
  if (await Post.findOne({ owner: req.user._id, status: "draft" }))
    return res
      .status(400)
      .json({ error: "You already have a draft waiting for approval." });
  const prefs =
    (req.user.toObject ? req.user.toObject() : req.user).preferences || {};
  let product;
  if (targetType === "product") {
    if (!mongoose.isValidObjectId(productId))
      return res.status(404).json({ error: "Product not found." });
    product = await Product.findOne({
      _id: productId,
      owner: req.user._id,
    }).lean();
    if (!product) return res.status(404).json({ error: "Product not found." });
  }
  const post = await Post.create({
    owner: req.user._id,
    text:
      text !== undefined
        ? text.trim()
        : product
          ? `${product.name} from ${profile.name}. ${product.description}`.slice(
              0,
              800,
            )
          : draftText(profile, prefs).slice(0, 800),
    targetType,
    product: product?._id || null,
    targetName: product?.name || profile.name,
    image: product?.image || profile.logo || "",
    platforms: prefs.platforms || [],
  });
  res.status(201).json({ post: pub(post) });
});

// Edit the text of a draft, or approve / skip it
router.patch("/posts/:id", requireAuth, ownerOnly, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id))
    return res.status(404).json({ error: "Post not found." });
  const { text, status } = req.body,
    update = {};
  if (text !== undefined) {
    const t = String(text).trim();
    if (!t || t.length > 800)
      return res
        .status(400)
        .json({ error: "Post text must be 1 to 800 characters." });
    update.text = t;
  }
  if (status !== undefined) {
    if (!["approved", "rejected"].includes(status))
      return res.status(400).json({ error: "Choose approve or skip." });
    update.status = status;
  }
  if (!Object.keys(update).length)
    return res.status(400).json({ error: "Nothing to update." });
  const post = await Post.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id, status: "draft" },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();
  if (!post)
    return res
      .status(404)
      .json({ error: "This post is no longer waiting for approval." });
  res.json({ post: pub(post) });
});

module.exports = router;
