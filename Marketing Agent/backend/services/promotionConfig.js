const fail = (code, message) => Object.assign(new Error(message), { code });
function base(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("PROMOTION_CONFIG", `Set ${name} in backend/.env.`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw fail(
      "PROMOTION_CONFIG",
      `${name} must use HTTPS (HTTP is allowed only on loopback).`,
    );
  return url.href.replace(/\/$/, "");
}
function number(env, key, fallback, min, max) {
  const value = Number(env[key] || fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw fail("PROMOTION_CONFIG", `Invalid ${key}.`);
  return value;
}
function config(env = process.env) {
  for (const key of ["GROQ_API_KEY", "IMAGE_API_KEY"])
    if (!env[key]?.trim())
      throw fail("PROMOTION_CONFIG", `Set ${key} in backend/.env.`);
  return {
    groqBase: base(
      env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      "GROQ_BASE_URL",
    ),
    groqKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
    imageBase: base(env.IMAGE_API_BASE_URL, "IMAGE_API_BASE_URL"),
    imageKey: env.IMAGE_API_KEY,
    pollMs: number(env, "PROMOTION_POLL_MS", 3000, 1000, 30000),
    timeoutMs: number(
      env,
      "PROMOTION_IMAGE_TIMEOUT_MS",
      900000,
      30000,
      3600000,
    ),
    requestMs: number(env, "PROMOTION_REQUEST_TIMEOUT_MS", 30000, 1000, 120000),
    maxBytes: number(
      env,
      "PROMOTION_MAX_IMAGE_BYTES",
      20971520,
      1024,
      104857600,
    ),
    autoStart: env.IMAGE_API_AUTO_START !== "false",
  };
}
const fingerprint = (c) =>
  require("node:crypto")
    .createHash("sha256")
    .update(c.imageBase + "\0" + c.imageKey)
    .digest("hex");
module.exports = { config, fail, fingerprint };
