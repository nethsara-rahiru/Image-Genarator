const { Schema, model } = require("mongoose");
const imageStep = new Schema(
  {
    prompt: { type: String, default: "" },
    remoteJobId: { type: String, default: "" },
    remoteState: { type: String, default: "" },
    chatId: { type: String, default: "" },
    chatUrl: { type: String, default: "" },
    imageId: { type: Schema.Types.ObjectId, required: true },
    contentType: String,
    width: Number,
    height: Number,
    bytes: Number,
    checksum: String,
    completedAt: Date,
  },
  { _id: false },
);
const schema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true },
    targetType: { type: String, enum: ["business", "product"], required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    targetName: String,
    provider: { type: String, required: true, select: false },
    worker: String,
    context: { type: Schema.Types.Mixed, required: true },
    references: { type: [String], required: true, select: false },
    state: {
      type: String,
      enum: [
        "queued",
        "prompting",
        "submitting",
        "generating",
        "downloading",
        "completed",
        "failed",
        "needs_review",
        "needs_login",
        "cancelled",
      ],
      default: "queued",
    },
    items: { type: [imageStep], required: true },
    current: { type: Number, default: 0 },
    error: { code: String, message: String },
    startedAt: Date,
    deadline: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
schema.index({ owner: 1, key: 1 }, { unique: true });
schema.index({ state: 1, createdAt: 1, _id: 1 });
schema.index({ owner: 1, createdAt: -1 });
module.exports = model("PromotionRun", schema);
