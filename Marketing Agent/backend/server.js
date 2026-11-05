require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mongoose = require("mongoose");

const {
  PORT = 3000,
  MONGODB_URI = "mongodb://127.0.0.1:27017/marketing_agent",
  JWT_SECRET,
} = process.env;
if (!JWT_SECRET || JWT_SECRET === "change-me") {
  console.error(
    "Set a real JWT_SECRET in backend/.env (copy .env.example to .env).",
  );
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    const server = require("./app").listen(PORT, () =>
      console.log(`Marketing Agent running at http://localhost:${PORT}`),
    );
    const worker = require("./services/promotionWorker").worker();
    worker.start();
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 15000);
      deadline.unref();
      await worker.stop();
      await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error(
      "Could not connect to MongoDB. Is the MongoDB service running?\n",
      err.message,
    );
    process.exit(1);
  });
