import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { equal } from "./security.js";
export const apiScopes = ["read", "generate", "browser"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const folder = (data) => path.join(data, "api-clients");
export async function readClients(data) {
  try {
    const rows = JSON.parse(
      await fs.readFile(path.join(folder(data), "clients.json"), "utf8"),
    );
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error("Invalid API client store");
    return rows;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function changeClients(data, operation) {
  const dir = folder(data);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(dir, { realpath: true, retries: 5 });
  try {
    const rows = await readClients(data);
    const result = operation(rows);
    const tmp = path.join(dir, randomUUID() + ".tmp");
    try {
      await fs.writeFile(tmp, JSON.stringify(rows), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(tmp, path.join(dir, "clients.json"));
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return result;
  } finally {
    await release();
  }
}
export function publicClient({ hash, ...client }) {
  return client;
}
export async function createClient(
  data,
  name,
  scopes = ["read", "generate"],
  days = 90,
) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9 _.-]{1,80}$/.test(name) ||
    !scopes.length ||
    scopes.some((s) => !apiScopes.includes(s)) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365
  )
    throw new Error(
      "Use a name (1–80 letters/digits/spaces/._-), valid scopes and expiry of 1–365 days",
    );
  const secret = "ig_" + randomBytes(32).toString("hex");
  return changeClients(data, (rows) => {
    if (rows.length >= 100) throw new Error("API client limit reached");
    const client = {
      id: randomUUID(),
      name,
      scopes: [...new Set(scopes)],
      hash: digest(secret),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
      revoked: false,
    };
    rows.push(client);
    return { ...publicClient(client), token: secret };
  });
}
export async function rotateClient(data, id, days = 90) {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error("Expiry must be 1–365 days");
  const secret = "ig_" + randomBytes(32).toString("hex");
  return changeClients(data, (rows) => {
    const client = rows.find((row) => row.id === id);
    if (!client) throw new Error("API client not found");
    Object.assign(client, {
      hash: digest(secret),
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
      revoked: false,
    });
    return { ...publicClient(client), token: secret };
  });
}
export async function revokeClient(data, id) {
  return changeClients(data, (rows) => {
    const client = rows.find((row) => row.id === id);
    if (!client) throw new Error("API client not found");
    client.revoked = true;
    return publicClient(client);
  });
}
export function clientAuthentication(config) {
  const limits = new Map();
  const admissions = new Map();
  return async (req, res, next) => {
    if (req.headers.origin && req.headers.origin !== config.origin)
      return res.status(403).json({ error: "Unexpected origin" });
    const ip = req.ip;
    let admission = admissions.get(ip);
    if (!admission || Date.now() - admission.at >= 60000) {
      admission = { at: Date.now(), count: 0 };
      admissions.delete(ip);
      admissions.set(ip, admission);
      if (admissions.size > 512)
        admissions.delete(admissions.keys().next().value);
    }
    if (++admission.count > 600) {
      res.set("Retry-After", "60");
      return res
        .status(429)
        .json({ error: "API admission rate limit exceeded" });
    }
    const value = /^Bearer (ig_[a-f0-9]{64})$/.exec(
      req.headers.authorization || "",
    )?.[1];
    if (!value) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "Valid API bearer token required" });
    }
    const hash = digest(value);
    const rows = await readClients(config.data);
    const client = rows.find((row) => equal(row.hash, hash));
    if (
      !value ||
      !client ||
      client.revoked ||
      !Number.isFinite(Date.parse(client.expiresAt)) ||
      Date.parse(client.expiresAt) <= Date.now()
    ) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "Valid API bearer token required" });
    }
    let window = limits.get(client.id);
    if (!window || Date.now() - window.at >= 60000) {
      window = { at: Date.now(), count: 0 };
      limits.set(client.id, window);
    }
    if (++window.count > 120) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "API rate limit exceeded" });
    }
    req.apiClient = publicClient(client);
    next();
  };
}
