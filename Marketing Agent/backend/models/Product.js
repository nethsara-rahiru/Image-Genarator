const { Schema, model } = require("mongoose");
module.exports = model(
  "Product",
  new Schema(
    {
      owner: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },
      name: { type: String, required: true, trim: true, maxlength: 80 },
      description: { type: String, trim: true, maxlength: 500, default: "" },
      image: { type: String, required: true, maxlength: 400000 },
    },
    { timestamps: true },
  ),
);
