const { Schema, model } = require('mongoose');
const O = require('./options');
module.exports = model('Post', new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, trim: true, maxlength: 800 },
  platforms: { type: [String], enum: O.PLATFORMS, default: [] },
  status: { type: String, enum: ['draft', 'approved', 'rejected'], default: 'draft' }
}, { timestamps: true }));
