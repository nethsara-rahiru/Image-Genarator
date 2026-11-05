const { Schema, model } = require("mongoose");
module.exports = model(
  "Profile",
  new Schema(
    {
      owner: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
      },
      name: { type: String, required: true, trim: true, maxlength: 80 },
      category: { type: String, default: "" },
      city: { type: String, default: "", maxlength: 40 },
      description: {
        type: String,
        required: true,
        minlength: 20,
        maxlength: 500,
      },
      logo: { type: String, default: "" }, // small data URL (resized to 256x256 by the frontend)
    },
    { timestamps: true },
  ),
);
