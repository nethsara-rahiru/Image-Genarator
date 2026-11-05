const router = require("express").Router();
const Profile = require("../models/Profile");
const { requireAuth } = require("../middleware/auth");

const CATEGORIES = [
  "",
  "Food & Drink",
  "Fashion",
  "Home & Living",
  "Services",
  "Other",
];

// Public: businesses shown in the marketplace
router.get("/businesses", async (req, res) => {
  const list = await Profile.find()
    .sort({ updatedAt: -1 })
    .limit(100)
    .select("name category city description logo -_id")
    .lean();
  res.json({ businesses: list });
});

router.get("/profile", requireAuth, async (req, res) => {
  const profile = await Profile.findOne({ owner: req.user._id })
    .select("-owner -__v")
    .lean();
  res.json({ profile });
});

router.put("/profile", requireAuth, async (req, res) => {
  if (req.user.role !== "owner")
    return res
      .status(403)
      .json({ error: "Only business owner accounts can create a profile." });
  const {
    name = "",
    category = "",
    city = "",
    description = "",
    logo = "",
  } = req.body;
  if (!name.trim())
    return res.status(400).json({ error: "Enter your business name." });
  if (description.trim().length < 20 || description.length > 500)
    return res
      .status(400)
      .json({ error: "Description must be 20 to 500 characters." });
  if (!CATEGORIES.includes(category))
    return res.status(400).json({ error: "Choose a valid category." });
  if (logo && (!logo.startsWith("data:image/") || logo.length > 400000))
    return res.status(400).json({ error: "Logo is invalid or too large." });

  const profile = await Profile.findOneAndUpdate(
    { owner: req.user._id },
    {
      name: name.trim(),
      category,
      city: city.trim().slice(0, 40),
      description: description.trim(),
      logo,
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  )
    .select("-owner -__v")
    .lean();
  res.json({ profile });
});

module.exports = router;
