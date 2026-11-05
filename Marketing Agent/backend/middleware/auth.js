const jwt = require("jsonwebtoken");
const User = require("../models/User");

function readUserId(req) {
  try {
    return jwt.verify(req.cookies.token, process.env.JWT_SECRET).id;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const id = readUserId(req);
  const user = id && (await User.findById(id));
  if (!user) return res.status(401).json({ error: "Log in to continue." });
  req.user = user;
  next();
}

module.exports = { requireAuth, readUserId };
