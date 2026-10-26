import fs from "node:fs/promises";
import path from "node:path";
import argon2 from "argon2";
export async function readAdmin(data) {
  try {
    return JSON.parse(await fs.readFile(path.join(data, "admin.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function writeAdmin(data, username, password, reset = false) {
  if (!/^[a-zA-Z0-9_.-]{3,100}$/.test(username))
    throw new Error(
      "Username must be 3–100 letters, digits, dots, dashes or underscores",
    );
  if (password.length < 14 || password.length > 256)
    throw new Error("Password must be 14–256 characters");
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  const existing = await readAdmin(data);
  if (reset && !existing)
    throw new Error("No admin exists. Run npm run setup-admin");
  if (!reset && existing)
    throw new Error("Admin already exists. Run npm run reset-admin");
  const admin = {
    username,
    hash: await argon2.hash(password, { type: argon2.argon2id }),
    version: (existing?.version || 0) + 1,
  };
  const target = path.join(data, "admin.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(admin), { mode: 0o600, flag: "wx" });
  await fs.rename(tmp, target);
  return admin;
}
