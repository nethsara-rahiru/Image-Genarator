const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { config } = require("../services/promotionConfig");
const { clients } = require("../services/promotionClients");
(async () => {
  if (!require("../services/availability").isOnline())
    throw Object.assign(
      new Error(
        "Marketing Agent is offline for maintenance. Set ONLINE=true and restart before contacting the image API.",
      ),
      { code: "MAINTENANCE" },
    );
  const api = clients(config());
  try {
    const health = await api.health();
    if (health.status !== "ok")
      throw Object.assign(
        new Error(
          "Image API health returned an unexpected response. Check IMAGE_API_BASE_URL; it must include /api/v1.",
        ),
        { code: "UPSTREAM_RESPONSE" },
      );
    console.log("Image API HTTPS/connection and read permission: OK");
    const browser = await api.browserStatus();
    console.log(
      "Browser running:",
      typeof browser.running === "boolean" ? browser.running : "unknown",
    );
    console.log(
      "This check did not start a browser, submit a prompt or generate an image.",
    );
  } finally {
    await api.close();
  }
})().catch((error) => {
  console.error(`${error.code || "IMAGE_API_CHECK_FAILED"}: ${error.message}`);
  process.exitCode = 1;
});
