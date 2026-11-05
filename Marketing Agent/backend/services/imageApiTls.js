const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");
const backend = path.join(__dirname, "..");
const invalid = (message) =>
  Object.assign(new Error(message), { code: "PROMOTION_TLS_CONFIG" });
function certificateBundle(value, variable) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 131072 ||
    /PRIVATE KEY/.test(value)
  )
    throw invalid(
      `${variable} must contain public PEM certificates only, not a private key.`,
    );
  const normalized = value.replace(/\\n/g, "\n").trim();
  const blocks =
    normalized.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) || [];
  const rest = normalized
    .replace(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      "",
    )
    .trim();
  if (!blocks.length || rest)
    throw invalid(
      `${variable} is not a valid PEM certificate bundle. Export the public CA certificate used by Postman.`,
    );
  try {
    return blocks.map((block) => new X509Certificate(block).toString());
  } catch {
    throw invalid(
      `${variable} contains an invalid certificate. Export the public CA certificate in PEM format.`,
    );
  }
}
function imageCertificates(env = process.env, directory = backend) {
  const certificates = [];
  const fileValue =
    env.IMAGE_API_CA_FILE?.trim() || env.NODE_EXTRA_CA_CERTS?.trim();
  if (fileValue) {
    const variable = env.IMAGE_API_CA_FILE?.trim()
      ? "IMAGE_API_CA_FILE"
      : "NODE_EXTRA_CA_CERTS";
    let file = fileValue;
    if (file.startsWith("~/") || file.startsWith("~\\"))
      file = path.join(os.homedir(), file.slice(2));
    file = path.resolve(directory, file);
    let pem;
    try {
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 131072)
        throw new Error();
      pem = fs.readFileSync(file, "utf8");
    } catch {
      throw invalid(
        `${variable} cannot be read as a certificate file. Set a real PEM file path in backend/.env. Paths are relative to backend; ~/ is supported.`,
      );
    }
    certificates.push(...certificateBundle(pem, variable));
  }
  if (env.IMAGE_API_CA_CERT?.trim())
    certificates.push(
      ...certificateBundle(env.IMAGE_API_CA_CERT, "IMAGE_API_CA_CERT"),
    );
  return [...new Set(certificates)];
}
function trustRoots(extra = []) {
  let defaults = tls.rootCertificates,
    system = [];
  if (typeof tls.getCACertificates === "function") {
    try {
      defaults = tls.getCACertificates("default");
    } catch {
      /* older Node */
    }
    try {
      system = tls.getCACertificates("system");
    } catch {
      /* platform without system store support */
    }
  }
  return [...new Set([...defaults, ...system, ...extra])];
}
function connectionError(error, label, imageApi = false) {
  const codes = new Set();
  function visit(value, depth = 0) {
    if (!value || depth > 5) return;
    if (typeof value.code === "string") codes.add(value.code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors))
      for (const child of value.errors.slice(0, 10)) visit(child, depth + 1);
    if (value.name === "TimeoutError") codes.add("TIMEOUT");
  }
  visit(error);
  let message,
    code = "UPSTREAM_UNAVAILABLE";
  const has = (...values) => values.some((value) => codes.has(value));
  if (
    has(
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT",
    )
  ) {
    code = "UPSTREAM_TLS";
    message = imageApi
      ? "The HTTPS certificate issuer is not trusted. Export the public CA used in Postman and set IMAGE_API_CA_FILE (or paste its PEM into IMAGE_API_CA_CERT) in backend/.env. Postman's private trust store is separate from Node. Restart Marketing Agent."
      : "The HTTPS certificate issuer is not trusted. Check the service or network's certificate chain.";
  } else if (has("ERR_TLS_CERT_ALTNAME_INVALID")) {
    code = "UPSTREAM_TLS";
    message =
      "The HTTPS certificate does not match the configured hostname/IP. Use an address listed in that certificate; adding a CA will not fix a name mismatch.";
  } else if (has("CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID")) {
    code = "UPSTREAM_TLS";
    message =
      "The HTTPS certificate is expired or not yet valid. Check the computer clock and renew the server certificate.";
  } else if (has("ECONNREFUSED"))
    message =
      "Connection was refused. Check that the configured service is running and the configured port is reachable.";
  else if (has("ENOTFOUND", "EAI_AGAIN"))
    message =
      "The configured server name could not be resolved. Check the base URL and DNS.";
  else if (
    has(
      "TIMEOUT",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    )
  )
    message =
      "The request timed out. Check network/VPN access, the configured address and service availability.";
  else
    message =
      "The connection failed. Check network access, the configured address and service availability.";
  return Object.assign(new Error(`${label}: ${message}`), { code });
}
module.exports = { imageCertificates, trustRoots, connectionError };
