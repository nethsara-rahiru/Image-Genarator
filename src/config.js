import path from "node:path";
export function configuration(env = process.env) {
  const integer = (name, fallback, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  const port = integer("PORT", 3030, 65535);
  const origin = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without a path or credentials",
    );
  const local =
    origin.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !local)
    throw new Error("Public access requires HTTPS");
  return {
    port,
    origin: origin.origin,
    secure: origin.protocol === "https:",
    data: path.resolve(env.DATA_DIR || "./runtime"),
    sessionMs: integer("SESSION_HOURS", 8, 24) * 3600000,
    idleMs: integer("BROWSER_IDLE_MINUTES", 30, 240) * 60000,
  };
}
