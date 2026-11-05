const { Schema, model } = require('mongoose');
const O = require('./options');

const userSchema = new Schema({
  // account details
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, default: '', trim: true },
  role: { type: String, enum: ['owner', 'customer', 'b2b'], default: 'owner' },
  passwordHash: { type: String, required: true },
  // preferences used to generate marketing posts
  preferences: {
    tone: { type: String, enum: O.TONES, default: 'friendly' },
    language: { type: String, enum: O.LANGUAGES, default: 'English' },
    platforms: { type: [String], enum: O.PLATFORMS, default: ['Facebook'] },
    postFrequency: { type: String, enum: O.FREQUENCIES, default: 'weekly' },
    brandColor: { type: String, match: /^#[0-9a-fA-F]{6}$/, default: '#1d6b52' },
    targetAudience: { type: String, maxlength: 150, default: '' }
  }
}, { timestamps: true });

module.exports = model('User', userSchema);
