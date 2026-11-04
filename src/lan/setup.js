import os from "node:os";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { findCommand } from "../native/common.js";
export const caddyVersion = "2.11.8";
export function privateLanIp(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const rows = [];
  for (const [name, addresses] of Object.entries(interfaces))
    for (const item of addresses || [])
      if (
        !item.internal &&
        privateLanIp(item.address) &&
        !rows.some((row) => row.address === item.address)
      )
        rows.push({ name, address: item.address });
  return rows.sort(
    (a, b) =>
      Number(/utun|tun|docker|bridge|veth|tailscale/i.test(a.name)) -
      Number(/utun|tun|docker|bridge|veth|tailscale/i.test(b.name)),
  );
}
export function selectLanHost(rows, requested) {
  if (
    requested &&
    rows.some((row) => row.address === requested) &&
    privateLanIp(requested)
  )
    return requested;
  if (requested)
    throw new Error(
      "LAN_HOST must be a private IPv4 address assigned to this PC. Check Wi-Fi/Ethernet settings.",
    );
  if (rows.length === 1) return rows[0].address;
  throw new Error(
    rows.length
      ? "Multiple network addresses found. Set LAN_HOST to your Wi-Fi/Ethernet IPv4 address."
      : "No private LAN IPv4 address found. Connect to Wi-Fi/Ethernet first.",
  );
}
export function caddyConfig(host, tlsPort, apiPort, storage) {
  if (
    !privateLanIp(host) ||
    !Number.isInteger(tlsPort) ||
    tlsPort < 1024 ||
    tlsPort > 65535 ||
    !Number.isInteger(apiPort) ||
    apiPort < 1 ||
    apiPort > 65535 ||
    tlsPort === apiPort
  )
    throw new Error("Invalid LAN IP or port configuration");
  return `{
  admin off
  auto_https disable_redirects
  skip_install_trust
  storage file_system {
    root ${JSON.stringify(storage.replaceAll("\\", "/"))}
  }
}
https://${host}:${tlsPort} {
  bind ${host}
  tls internal
  reverse_proxy 127.0.0.1:${apiPort} {
    flush_interval -1
  }
}
`;
}
export function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (output.length < 16000) output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("LAN setup command timed out"));
    }, 30000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(
              `LAN setup command failed (${path.basename(file)}, exit ${code})`,
            ),
          );
    });
  });
}
export function archiveName(platform = process.platform, arch = process.arch) {
  const targetOs = { darwin: "mac", win32: "windows", linux: "linux" }[
    platform
  ];
  const targetArch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!targetOs || !targetArch)
    throw new Error(
      "LAN setup supports Windows/macOS/Linux on x64 or arm64. Install Caddy manually and set CADDY_PATH for other platforms.",
    );
  return `caddy_${caddyVersion}_${targetOs}_${targetArch}.${platform === "win32" ? "zip" : "tar.gz"}`;
}
async function download(url, maxBytes, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body)
    throw new Error(
      `Official Caddy download failed (HTTP ${response.status}); check your internet connection or set CADDY_PATH to an installed Caddy.`,
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes)
      throw new Error("Caddy download exceeds the expected size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function installCaddy(
  dir,
  {
    platform = process.platform,
    arch = process.arch,
    fetchImpl = fetch,
    extract = command,
  } = {},
) {
  const asset = archiveName(platform, arch),
    binaryName = platform === "win32" ? "caddy.exe" : "caddy";
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const base = `https://github.com/caddyserver/caddy/releases/download/v${caddyVersion}/`;
  const sums = (
    await download(
      base + `caddy_${caddyVersion}_checksums.txt`,
      1024 * 1024,
      fetchImpl,
    )
  ).toString("utf8");
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === asset)?.[0];
  if (!/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i.test(expected || ""))
    throw new Error(
      "Official release checksum is missing; Caddy was not installed",
    );
  const bytes = await download(base + asset, 128 * 1024 * 1024, fetchImpl);
  if (
    createHash(expected.length === 128 ? "sha512" : "sha256")
      .update(bytes)
      .digest("hex") !== expected.toLowerCase()
  )
    throw new Error("Caddy checksum mismatch; download rejected");
  const temp = await fs.mkdtemp(path.join(dir, "install-"));
  try {
    const archive = path.join(temp, asset);
    await fs.writeFile(archive, bytes, { mode: 0o600 });
    await extract("tar", ["-xf", archive, "-C", temp, binaryName]);
    const source = path.join(temp, binaryName);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Invalid Caddy binary in release archive");
    await fs.chmod(source, 0o700);
    const destination = path.join(dir, binaryName);
    await fs.rename(source, destination);
    return destination;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function ensureCaddy(lanDir, override) {
  const name = process.platform === "win32" ? "caddy.exe" : "caddy";
  const candidates = [
    override,
    path.join(lanDir, "bin", name),
    await findCommand("caddy"),
    path.join(os.homedir(), ".local", "bin", name),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      await command(file, ["version"]);
      return file;
    } catch {
      if (file === override)
        throw new Error(
          "CADDY_PATH could not run. Select an installed Caddy executable.",
        );
    }
  }
  console.log(
    `Downloading official Caddy ${caddyVersion} for ${process.platform}/${process.arch}; verifying release checksum…`,
  );
  const binary = await installCaddy(path.join(lanDir, "bin"));
  await command(binary, ["version"]);
  return binary;
}
