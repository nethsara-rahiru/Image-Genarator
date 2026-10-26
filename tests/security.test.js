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
test("browser startup diagnostics are actionable and never echo private launch text", async () => {
  const { browserStartupError } = await import("../src/browserErrors.js");
  for (const [message, code] of [
    ["Executable doesn't exist at /private/user/browser", "BROWSER_MISSING"],
    ["Host system is missing dependencies", "BROWSER_DEPENDENCIES"],
    ["Failed to create ProcessSingleton", "BROWSER_PROFILE_BUSY"],
    ["No usable sandbox! Operation not permitted", "BROWSER_SANDBOX"],
    ["Run as a non-root Linux user", "BROWSER_ROOT"],
    ["EACCES: private file", "BROWSER_PERMISSIONS"],
    ["Timeout 30000ms exceeded", "BROWSER_START_TIMEOUT"],
    ["unknown failure secret=do-not-echo", "BROWSER_START_FAILED"],
  ]) {
    const diagnosis = browserStartupError(new Error(message));
    assert.equal(diagnosis.code, code);
    assert.doesNotMatch(diagnosis.message, /do-not-echo|\/private\/user/);
  }
});
test("public IPv4 and IPv6 ranges are not confused with adjacent reserved subnets", async () => {
  for (const ip of [
    "192.0.78.24",
    "192.0.1.1",
    "192.0.0.9",
    "192.0.0.10",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "2001:4860:4860::8888",
    "2001:4860:4860::8844",
    "2001:678::1",
    "2606:4700:4700::1111",
    "2a00:1450:4009:818::2004",
    "2001:4860:4860:0000:0000:0000:0000:8888",
  ])
    assert.equal(privateAddress(ip), false, ip);
  for (const ip of [
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.51.100.1",
    "203.0.113.1",
    "100.64.0.0",
    "100.127.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "2001:0:1234::1",
    "2001:2::1",
    "2001:db8::1",
    "2001:10::1",
    "2001:20::1",
    "2002:7f00:1::1",
    "3fff::1",
    "64:ff9b::7f00:1",
    "::ffff:192.168.1.1",
    "::ffff:8.8.8.8",
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const answers of [
    [{ address: "192.0.78.24" }],
    [{ address: "8.8.8.8" }, { address: "2001:4860:4860::8888" }],
  ])
    assert.equal(
      await publicUrl("https://public.example/", async () => answers),
      "https://public.example/",
    );
  await assert.rejects(
    publicUrl("https://mixed.example/", async () => [
      { address: "2001:4860:4860::8888" },
      { address: "::1" },
    ]),
    (error) => error.reason === "NON_PUBLIC_DNS_ADDRESS",
  );
  await assert.rejects(
    publicUrl("https://empty.example/", async () => []),
    (error) => error.reason === "NO_DNS_ADDRESSES",
  );
});

test("Google search accepts public 2001 IPv6 answers while mixed private answers stay blocked", async () => {
  const target = "https://www.google.com/search?q=browser";
  assert.equal(
    await publicUrl(target, async () => [
      { address: "142.250.180.100" },
      { address: "2001:4860:4802:38::78" },
    ]),
    target,
  );
  await assert.rejects(
    publicUrl(target, async () => [
      { address: "142.250.180.100" },
      { address: "169.254.169.254" },
    ]),
  );
});
