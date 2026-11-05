const { Schema, model } = require("mongoose");
const O = require("./options");
module.exports = model(
  "Post",
  new Schema(
    {
      owner: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },
      text: { type: String, required: true, trim: true, maxlength: 800 },
      targetType: {
        type: String,
        enum: ["business", "product"],
        default: "business",
      },
      product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
      targetName: { type: String, maxlength: 80, default: "" },
      image: { type: String, maxlength: 400000, default: "" },
      platforms: { type: [String], enum: O.PLATFORMS, default: [] },
      status: {
        type: String,
        enum: ["draft", "approved", "rejected"],
        default: "draft",
      },
    },
    { timestamps: true },
  ),
);
