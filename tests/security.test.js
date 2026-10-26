import test from "node:test";
import assert from "node:assert/strict";
import { publicUrl, privateAddress } from "../src/security.js";
import { configuration } from "../src/config.js";
import { writeAdmin, readAdmin } from "../src/admin.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("only encrypted public origins or loopback tunnel origins are permitted", () => {
  assert.equal(configuration({}).port, 3030);
  for (const origin of [
    "http://162.35.181.135:3030",
    "https://user:pass@example.com",
    "https://example.com/path",
    "ftp://example.com",
  ])
    assert.throws(() => configuration({ PUBLIC_ORIGIN: origin }));
  assert.equal(
    configuration({ PUBLIC_ORIGIN: "https://162.35.181.135:3443" }).secure,
    true,
  );
  assert.throws(() => configuration({ PORT: "hello" }));
});
test("navigation blocks private networks, metadata, credentials, unsafe schemes and mixed DNS answers", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.3.2",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "2002::1",
  ])
    assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress("8.8.8.8"), false);
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::1]",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost",
    "http://a.local",
    "https://a:b@example.com",
  ])
    await assert.rejects(publicUrl(value));
  await assert.rejects(
    publicUrl("https://mixed.example", async () => [
      { address: "8.8.8.8" },
      { address: "10.0.0.1" },
    ]),
  );
  assert.equal(
    await publicUrl("https://public.example/a", async () => [
      { address: "8.8.8.8" },
    ]),
    "https://public.example/a",
  );
});
test("admin bootstrap is unique, hashed and reset invalidates prior identity version", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "remote-admin-"));
  try {
    assert.equal(await readAdmin(data), null);
    await assert.rejects(writeAdmin(data, "admin", "short"));
    await writeAdmin(data, "admin", "a sufficiently long password");
    const a = await readAdmin(data);
    assert.match(a.hash, /argon2id/);
    assert.equal(a.version, 1);
    await assert.rejects(writeAdmin(data, "other", "another long password"));
    await writeAdmin(data, "admin", "a changed strong password", true);
    assert.equal((await readAdmin(data)).version, 2);
    if (process.platform !== "win32")
      assert.equal(
        (await fs.stat(path.join(data, "admin.json"))).mode & 0o777,
        0o600,
      );
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});
