const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { readUserId } = require('../middleware/auth');

const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const publicUser = require('../utils/publicUser');

function startSession(res, user) {
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000
  });
}

router.post('/signup', async (req, res) => {
  const { name = '', email = '', password = '', role = 'owner' } = req.body;
  if (name.trim().length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for the password.' });
  if (!['owner', 'customer', 'b2b'].includes(role)) return res.status(400).json({ error: 'Choose a valid account type.' });
  try {
    const user = await User.create({ name, email, role, passwordHash: await bcrypt.hash(password, 10) });
    startSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.' });
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = await User.findOne({ email: String(email).trim().toLowerCase() });
  if (!user || !(await bcrypt.compare(String(password), user.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  startSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

router.get('/me', async (req, res) => {
  const id = readUserId(req);
  const user = id && await User.findById(id);
  res.json({ user: user ? publicUser(user) : null });
});

module.exports = router;
