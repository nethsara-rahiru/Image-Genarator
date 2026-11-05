const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/account'));
app.use('/api', require('./routes/posts'));
app.use('/api', require('./routes/business'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Only the frontend folder is public (never the backend or .env)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Try again.' });
});

module.exports = app;
