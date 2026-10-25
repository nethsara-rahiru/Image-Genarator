import mongoose from "mongoose";
const { Schema } = mongoose;
mongoose.set("bufferCommands", false);
mongoose.set("autoCreate", false);
mongoose.set("autoIndex", false);
const ref = (model, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: model,
  required,
  index: true,
});
const make = (name, fields, indexes = []) => {
  const s = new Schema(fields, { timestamps: true, strict: "throw" });
  for (const [keys, options] of indexes) s.index(keys, options);
  return mongoose.model(name, s);
};
export const AdminUser = make("AdminUser", {
  singleton: { type: String, default: "admin", unique: true, enum: ["admin"] },
  username: { type: String, required: true },
  passwordHash: { type: String, required: true, select: false },
});
export const GoogleAccount = make("GoogleAccount", {
  email: { type: String, required: true },
  state: {
    type: String,
    enum: [
      "disconnected",
      "login_required",
      "authenticating",
      "ready",
      "expired",
      "error",
    ],
    default: "disconnected",
  },
  disabled: { type: Boolean, default: false },
  lastVerified: Date,
});
export const GeminiChat = make(
  "GeminiChat",
  {
    accountId: ref("GoogleAccount"),
    url: String,
    title: { type: String, default: "New chat" },
    status: {
      type: String,
      enum: ["pending", "active", "archived"],
      default: "pending",
    },
  },
  [[{ accountId: 1, updatedAt: -1 }, {}]],
);
export const GenerationJob = make(
  "GenerationJob",
  {
    accountId: ref("GoogleAccount"),
    chatId: ref("GeminiChat", false),
    createNew: Boolean,
    prompt: { type: String, required: true },
    assetIds: [ref("Asset")],
    state: {
      type: String,
      enum: [
        "queued",
        "running",
        "uploading_assets",
        "submitting_prompt",
        "generating",
        "downloading",
        "completed",
        "failed",
        "cancelled",
        "needs_login",
        "needs_review",
      ],
      default: "queued",
    },
    attempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    enqueuedAt: { type: Date, default: Date.now, required: true },
    owner: String,
    fence: Number,
    heartbeat: Date,
    leaseUntil: Date,
    progress: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    submissionStartedAt: Date,
    submittedAt: Date,
    finishedAt: Date,
    error: { code: String, message: String },
    outputId: ref("GeneratedOutput", false),
  },
  [[{ state: 1, enqueuedAt: 1, _id: 1 }, {}]],
);
export const GeneratedOutput = make("GeneratedOutput", {
  jobId: {
    type: Schema.Types.ObjectId,
    ref: "GenerationJob",
    required: true,
    unique: true,
  },
  accountId: ref("GoogleAccount"),
  chatId: ref("GeminiChat", false),
  filename: { type: String, required: true },
  contentType: String,
  width: Number,
  height: Number,
  format: String,
  bytes: Number,
  checksum: String,
  metadata: Schema.Types.Mixed,
});
export const ElementLocator = make(
  "ElementLocator",
  {
    context: String,
    action: String,
    type: String,
    value: String,
    lastVerified: Date,
    successes: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    history: [
      { value: String, type: { type: String }, at: Date, verified: Boolean },
    ],
  },
  [[{ context: 1, action: 1 }, { unique: true }]],
);
export const AutomationEvent = make(
  "AutomationEvent",
  {
    jobId: ref("GenerationJob", false),
    accountId: ref("GoogleAccount", false),
    type: String,
    message: String,
    recovery: Schema.Types.Mixed,
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  },
  [[{ createdAt: -1, _id: -1 }, {}]],
);
export const Asset = make("Asset", {
  filename: String,
  originalName: String,
  contentType: String,
  bytes: Number,
  checksum: String,
});
export const Lease = make("Lease", {
  _id: String,
  owner: String,
  fence: { type: Number, default: 0 },
  expiresAt: Date,
  snapshotJobId: { type: Schema.Types.ObjectId, ref: "GenerationJob" },
  snapshotAt: Date,
  snapshotFilename: String,
  snapshotAccountId: { type: Schema.Types.ObjectId, ref: "GoogleAccount" },
});
export const Setting = make("Setting", {
  _id: { type: String, default: "global" },
  generationTimeoutMs: { type: Number, default: 240000 },
  retryLimit: { type: Number, default: 1 },
  retentionDays: { type: Number, default: 30 },
  groqEnabled: { type: Boolean, default: false },
  groqModel: { type: String, default: "openai/gpt-oss-120b" },
});
export async function connect(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(
    Object.values(mongoose.models).map(async (m) => {
      await m.createCollection();
      await m.createIndexes();
    }),
  );
}
