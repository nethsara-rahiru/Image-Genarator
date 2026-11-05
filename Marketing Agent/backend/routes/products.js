const router = require("express").Router();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const validImage = require("../utils/productImage");
const { requireAuth } = require("../middleware/auth");
router.use(requireAuth, (req, res, next) =>
  req.user.role === "owner"
    ? next()
    : res
        .status(403)
        .json({ error: "Only business owners can manage products." }),
);
const pub = ({ _id, name, description, image, createdAt }) => ({
  _id,
  name,
  description,
  image,
  createdAt,
});
router.get("/", async (req, res) => {
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
      .json({ error: "Use limit 1–100 and nonnegative offset." });
  const filter = { owner: req.user._id };
  const [rows, total] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);
  res.json({ products: rows.map(pub), total, limit, offset });
});
router.post("/", async (req, res) => {
  const { name, description = "", image } = req.body || {};
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 80 ||
    typeof description !== "string" ||
    description.length > 500 ||
    !validImage(image)
  )
    return res.status(400).json({
      error:
        "Provide a product name (1–80 characters), description (up to 500), and a valid PNG/JPEG/WebP image under 300 KB.",
    });
  const product = await Product.create({
    owner: req.user._id,
    name: name.trim(),
    description: description.trim(),
    image,
  });
  res.status(201).json({ product: pub(product.toObject()) });
});
router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id))
    return res.status(404).json({ error: "Product not found." });
  const product = await Product.findOneAndDelete({
    _id: req.params.id,
    owner: req.user._id,
  });
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true });
});
module.exports = router;
