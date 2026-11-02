import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { publicUrl } from "../security.js";
export async function startBrowserProxy({
  log,
  resolve = lookup,
  validate = publicUrl,
} = {}) {
  const sockets = new Set();
  let stopped = false;
  async function destination(value) {
    let answers;
    const target = await validate(value, async (host, options) => {
      answers = await resolve(host, options);
      return answers;
    });
    const url = new URL(target),
      host = url.hostname.replace(/^\[|\]$/g, "");
    if (!answers) answers = [{ address: host, family: net.isIP(host) }];
    const selected = answers.find((a) => a.family === 4) || answers[0];
    return {
      url,
      address: selected.address,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  const denied = (error) =>
    log?.write(
      "warn",
      "network",
      error.code === "ENOTFOUND" ? "DNS_FAILED" : "REQUEST_BLOCKED",
      "A native browser request failed destination validation.",
      { reason: error.reason },
      3000,
    );
  const server = http.createServer(async (req, res) => {
    let outgoing;
    try {
      if (stopped || sockets.size > 100) throw new Error("Proxy capacity");
      const { url, address, port } = await destination(req.url);
      if (url.protocol !== "http:") throw new Error("Use CONNECT for TLS");
      const headers = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      outgoing = http.request(
        {
          host: address,
          port,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          timeout: 20000,
        },
        (response) => {
          if (response.statusCode >= 400)
            log?.write(
              "warn",
              "network",
              "HTTP_ERROR",
              "A native HTTP response returned an error.",
              { status: response.statusCode },
              3000,
            );
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      outgoing.on("socket", track);
      outgoing.on("timeout", () => outgoing.destroy());
      outgoing.on("error", () => {
        log?.write(
          "warn",
          "network",
          "CONNECTION_FAILED",
          "A native HTTP connection could not complete.",
          {},
          3000,
        );
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => outgoing.destroy());
      req.pipe(outgoing);
    } catch (error) {
      denied(error);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Destination is not permitted. Check the application debug log.");
    }
  });
  server.on("connect", async (req, client, head) => {
    try {
      if (stopped || sockets.size > 100) throw new Error("Proxy capacity");
      const { address, port } = await destination(`https://${req.url}/`);
      const remote = net.connect({ host: address, port });
      track(remote);
      remote.setTimeout(120000, () => remote.destroy());
      remote.on("connect", () => {
        if (client.destroyed) {
          remote.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      remote.on("error", () => {
        log?.write(
          "warn",
          "network",
          "CONNECTION_FAILED",
          "A native TLS connection could not complete.",
          {},
          3000,
        );
        client.destroy();
      });
      client.on("close", () => remote.destroy());
    } catch (error) {
      denied(error);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("upgrade", async (req, client, head) => {
    try {
      if (stopped || sockets.size > 100) throw new Error("Proxy capacity");
      const value = req.url.replace(/^ws:/, "http:");
      const { url, address, port } = await destination(value);
      if (url.protocol !== "http:") throw new Error("Invalid upgrade");
      const remote = net.connect({ host: address, port });
      track(remote);
      remote.setTimeout(120000, () => remote.destroy());
      remote.on("connect", () => {
        if (client.destroyed) {
          remote.destroy();
          return;
        }
        const headers = { ...req.headers, host: url.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const lines = Object.entries(headers).flatMap(([key, value]) =>
          (Array.isArray(value) ? value : [value]).map(
            (part) => `${key}: ${String(part).replace(/[\r\n]/g, "")}`,
          ),
        );
        remote.write(
          `GET ${url.pathname + url.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
    } catch (error) {
      denied(error);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("connection", track);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    async close() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
