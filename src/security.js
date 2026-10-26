import { isIP, BlockList } from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
export const token = () => randomBytes(32).toString("hex");
export function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  blockedV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  blockedV6.addSubnet(network, prefix, "ipv6");
export function privateAddress(address) {
  if (typeof address !== "string") return true;
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) {
    // IANA globally reachable anycast exceptions inside 192.0.0.0/24.
    if (ip === "192.0.0.9" || ip === "192.0.0.10") return false;
    return blockedV4.check(ip, "ipv4");
  }
  if (family === 6)
    return !globalV6.check(ip, "ipv6") || blockedV6.check(ip, "ipv6");
  return true;
}
export class DestinationBlockedError extends Error {
  constructor(reason) {
    super("Private addresses are blocked");
    this.name = "DestinationBlockedError";
    this.code = "DESTINATION_BLOCKED";
    this.reason = reason;
  }
}
export async function publicUrl(value, resolver = lookup) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only public HTTP/HTTPS addresses are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new DestinationBlockedError("PRIVATE_HOSTNAME");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await resolver(host, { all: true });
  if (!addresses.length) throw new DestinationBlockedError("NO_DNS_ADDRESSES");
  if (addresses.some((a) => privateAddress(a.address)))
    throw new DestinationBlockedError("NON_PUBLIC_DNS_ADDRESS");
  return url.href;
}
