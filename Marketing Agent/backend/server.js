require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mongoose = require("mongoose");
const { isOnline } = require("./services/availability");
const {
  PORT = 3000,
  MONGODB_URI = "mongodb://127.0.0.1:27017/marketing_agent",
  JWT_SECRET,
} = process.env;

async function start() {
  const online = isOnline();
  // The maintenance page must work even when MongoDB is stopped for maintenance.
  if (online) {
    if (!JWT_SECRET || JWT_SECRET === "change-me")
      throw new Error(
        "Set a real JWT_SECRET in backend/.env (run npm run setup-env).",
      );
    try {
      await mongoose.connect(MONGODB_URI);
    } catch {
      throw new Error(
        "Could not connect to MongoDB. Check MONGODB_URI and database availability.",
      );
    }
    console.log("Connected to MongoDB");
  }
  const server = require("./app").listen(PORT, () => {
    console.log(
      online
        ? `Marketing Agent running at http://localhost:${PORT}`
        : `Marketing Agent maintenance mode at http://localhost:${PORT}; all application access is blocked.`,
    );
  });
  const worker = online ? require("./services/promotionWorker").worker() : null;
  worker?.start();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    await worker?.stop();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("error", () => {
    console.error("Could not listen on the configured Marketing Agent port.");
    shutdown().catch(() => process.exit(1));
    process.exitCode = 1;
  });
}
start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
