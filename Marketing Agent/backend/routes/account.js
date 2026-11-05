const router = require('express').Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Profile = require('../models/Profile');
const Post = require('../models/Post');
const O = require('../models/options');
const publicUser = require('../utils/publicUser');
const { requireAuth } = require('../middleware/auth');

const bad = (res, error) => res.status(400).json({ error });

// Partial update: send "name"/"phone" and/or "preferences"
router.patch('/account', requireAuth, async (req, res) => {
  const { name, phone, preferences } = req.body;
  const update = {};

  if (name !== undefined) {
    if (String(name).trim().length < 2) return bad(res, 'Enter your full name.');
    update.name = String(name).trim().slice(0, 80);
  }
  if (phone !== undefined) {
    if (phone && !/^\+?[0-9\s-]{7,15}$/.test(phone)) return bad(res, 'Enter a valid phone number.');
    update.phone = String(phone).trim();
  }
  if (preferences !== undefined) {
    const p = preferences || {};
    const platforms = [...new Set(Array.isArray(p.platforms) ? p.platforms : [])];
    if (!O.TONES.includes(p.tone)) return bad(res, 'Choose a valid tone.');
    if (!O.LANGUAGES.includes(p.language)) return bad(res, 'Choose a valid language.');
    if (!platforms.length || !platforms.every(x => O.PLATFORMS.includes(x))) return bad(res, 'Choose at least one platform.');
    if (!O.FREQUENCIES.includes(p.postFrequency)) return bad(res, 'Choose how often to post.');
    if (!/^#[0-9a-fA-F]{6}$/.test(p.brandColor || '')) return bad(res, 'Choose a valid brand colour.');
    if (String(p.targetAudience || '').length > 150) return bad(res, 'Target audience must be 150 characters or fewer.');
    update.preferences = {
      tone: p.tone, language: p.language, platforms, postFrequency: p.postFrequency,
      brandColor: p.brandColor, targetAudience: String(p.targetAudience || '').trim()
    };
  }
  if (!Object.keys(update).length) return bad(res, 'Nothing to update.');

  const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true, runValidators: true });
  res.json({ user: publicUser(user) });
});

// Change password (needs the current password)
router.post('/account/password', requireAuth, async (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body;
  if (!(await bcrypt.compare(String(currentPassword), req.user.passwordHash))) return bad(res, 'Current password is incorrect.');
  if (String(newPassword).length < 8) return bad(res, 'Use at least 8 characters for the new password.');
  await User.findByIdAndUpdate(req.user._id, { $set: { passwordHash: await bcrypt.hash(String(newPassword), 10) } });
  res.json({ ok: true });
});

// Delete the account and its business profile (needs the password)
router.delete('/account', requireAuth, async (req, res) => {
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.passwordHash))) return bad(res, 'Password is incorrect.');
  await Profile.deleteOne({ owner: req.user._id });
  await Post.deleteMany({ owner: req.user._id });
  await User.deleteOne({ _id: req.user._id });
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
