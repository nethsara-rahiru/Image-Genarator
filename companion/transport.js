import https from "node:https";
import { X509Certificate } from "node:crypto";
export function serverOrigin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error(
      "Enter an HTTPS server origin, without a path or credentials",
    );
  return u.origin;
}
export function certificateInfo(pem) {
  if (!pem) return null;
  const cert = new X509Certificate(pem);
  if (!cert.ca)
    throw new Error(
      "Choose the public root CA certificate, not a private key or leaf certificate",
    );
  return cert.fingerprint256;
}
export function remoteRequest(
  config,
  path,
  { method = "GET", body, headers = {}, limit = 45 * 1024 * 1024 } = {},
) {
  if (!/^\/api\/companion(?:\/|$)/.test(path))
    throw new Error("Invalid companion API path");
  const origin = serverOrigin(config.origin);
  let data;
  if (body !== undefined && !Buffer.isBuffer(body)) {
    data = Buffer.from(JSON.stringify(body));
    headers = { "content-type": "application/json", ...headers };
  } else data = body;
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(path, origin),
      {
        method,
        ca: config.ca || undefined,
        rejectUnauthorized: true,
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          ...(data ? { "content-length": data.length } : {}),
          ...headers,
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new Error("Server response exceeds limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          let parsed;
          try {
            parsed = JSON.parse(buffer.toString());
          } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const e = new Error(
              parsed?.error?.message ||
                `Server returned HTTP ${res.statusCode}`,
            );
            e.code = parsed?.error?.code;
            e.status = res.statusCode;
            reject(e);
            return;
          }
          resolve({
            data: parsed,
            buffer,
            status: res.statusCode,
            headers: res.headers,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Server request timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
