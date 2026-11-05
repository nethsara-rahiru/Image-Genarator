const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const {
  imageCertificates,
  trustRoots,
  connectionError,
} = require("../services/imageApiTls");
const { clients } = require("../services/promotionClients");

test("certificate and network failures produce specific sanitized errors", () => {
  for (const [cause, code, match] of [
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UPSTREAM_TLS", /Postman.*separate/],
    ["SELF_SIGNED_CERT_IN_CHAIN", "UPSTREAM_TLS", /IMAGE_API_CA_FILE/],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "UPSTREAM_TLS", /does not match/],
    ["CERT_HAS_EXPIRED", "UPSTREAM_TLS", /expired/],
    ["ECONNREFUSED", "UPSTREAM_UNAVAILABLE", /refused/],
    ["ENOTFOUND", "UPSTREAM_UNAVAILABLE", /resolved/],
    ["UND_ERR_CONNECT_TIMEOUT", "UPSTREAM_UNAVAILABLE", /timed out/],
  ]) {
    const error = connectionError(
      { cause: { code: cause, message: "private-token" } },
      "Image API browser start",
      true,
    );
    assert.equal(error.code, code);
    assert.match(error.message, match);
    assert.doesNotMatch(error.message, /private-token/);
  }
  assert.match(
    connectionError(
      { cause: { errors: [{ code: "ECONNREFUSED" }] } },
      "Image API browser start",
      true,
    ).message,
    /refused/,
  );
});

test(
  "image API trusts a configured PEM with real HTTPS, including late dotenv loading",
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ma-certificate-"),
    );
    const requests = [];
    const servers = [],
      connections = new Set();
    t.after(async () => {
      for (const socket of connections) socket.destroy();
      for (const server of servers)
        await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const openssl = (args) =>
      execute("openssl", args, { cwd: directory, timeout: 15000 });
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca root.crt",
      "-subj",
      "/CN=Marketing Agent test CA",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=localhost",
    ]);
    await fs.writeFile(
      path.join(directory, "ip.ext"),
      "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
    );
    await fs.writeFile(
      path.join(directory, "dns.ext"),
      "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
    );
    for (const name of ["ip", "dns"])
      await openssl([
        "x509",
        "-req",
        "-in",
        "server.csr",
        "-CA",
        "ca root.crt",
        "-CAkey",
        "ca.key",
        "-set_serial",
        name === "ip" ? "2" : "3",
        "-out",
        `${name}.crt`,
        "-days",
        "2",
        "-extfile",
        `${name}.ext`,
      ]);
    const pem = await fs.readFile(path.join(directory, "ca root.crt"), "utf8");
    const { png } = await import("../../../tests/fixtures/png.js");
    const bytes = png();
    const start = async (name) => {
      const server = https.createServer(
        {
          key: await fs.readFile(path.join(directory, "server.key")),
          cert: await fs.readFile(path.join(directory, `${name}.crt`)),
        },
        async (req, res) => {
          requests.push({ method: req.method, url: req.url });
          for await (const ignored of req) {
            void ignored;
          }
          if (req.headers.authorization !== "Bearer private-test-token") {
            res.writeHead(401);
            res.end("{}");
            return;
          }
          res.setHeader("Content-Type", "application/json");
          if (req.url.endsWith("/health")) {
            res.end('{"status":"ok"}');
          } else if (req.url.endsWith("/browser/status")) {
            res.end('{"running":true}');
          } else if (req.url.endsWith("/image")) {
            res.setHeader("Content-Type", "image/png");
            res.end(bytes);
          } else if (req.url.endsWith("/browser/start"))
            res.end('{"running":true}');
          else res.end('{"id":"tls-job","state":"completed"}');
        },
      );
      server.on("connection", (socket) => {
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      return `https://127.0.0.1:${server.address().port}`;
    };
    const origin = await start("ip");
    const settings = {
      imageBase: origin + "/api/v1",
      imageKey: "private-test-token",
      groqBase: origin,
      groqKey: "private-groq-token",
      requestMs: 3000,
      maxBytes: 1024,
    };
    const withClient = async (options, fn) => {
      const api = clients({ ...settings, ...options });
      try {
        return await fn(api);
      } finally {
        await api.close();
      }
    };
    await t.test("untrusted issuer is rejected without disabling TLS", () =>
      withClient({}, (api) =>
        assert.rejects(
          api.start(),
          (e) => e.code === "UPSTREAM_TLS" && /issuer/.test(e.message),
        ),
      ),
    );
    await t.test(
      "file path handles browser start, multipart submission, polling and original download",
      async () => {
        const imageCa = imageCertificates(
          { IMAGE_API_CA_FILE: "ca root.crt" },
          directory,
        );
        assert.ok(
          trustRoots(imageCa).includes(pem.trim() + "\n") ||
            trustRoots(imageCa).includes(pem.trim()),
        );
        await withClient({ imageCa }, async (api) => {
          assert.equal((await api.start()).running, true);
          assert.equal(
            (
              await api.submit(
                "test prompt",
                ["data:image/png;base64," + bytes.toString("base64")],
                "tls-test-0001",
              )
            ).id,
            "tls-job",
          );
          assert.equal((await api.status("tls-job")).state, "completed");
          assert.deepEqual(await api.download("tls-job"), bytes);
          await assert.rejects(
            api.prompt({}, 0, []),
            (e) => e.code === "UPSTREAM_TLS",
            "image API CA must not change Groq/global trust",
          );
        });
      },
    );
    await t.test("pasted multiline or escaped PEM also works", async () => {
      for (const value of [pem, pem.replace(/\n/g, "\\n")])
        await withClient(
          { imageCa: imageCertificates({ IMAGE_API_CA_CERT: value }) },
          async (api) => assert.equal((await api.start()).running, true),
        );
    });
    await t.test(
      "NODE_EXTRA_CA_CERTS in dotenv works even after the Node process already started",
      async () => {
        const file = path.join(directory, ".env");
        await fs.writeFile(
          file,
          `GROQ_API_KEY=test\nIMAGE_API_KEY=private-test-token\nIMAGE_API_BASE_URL=${settings.imageBase}\nNODE_EXTRA_CA_CERTS="${path.join(directory, "ca root.crt").replaceAll("\\", "/")}"\n`,
          { mode: 0o600 },
        );
        const code = `require('dotenv').config({path:process.env.TLS_TEST_ENV,override:true}); const {config}=require('./services/promotionConfig');const {clients}=require('./services/promotionClients');(async()=>{const api=clients(config());try{console.log('TLS_START_OK', (await api.start()).running)}finally{await api.close()}})().catch(e=>{console.error(e.code);process.exitCode=1});`;
        const child = await execute(process.execPath, ["-e", code], {
          cwd: path.join(__dirname, ".."),
          env: { ...process.env, TLS_TEST_ENV: file },
          timeout: 10000,
        });
        assert.match(child.stdout, /TLS_START_OK true/);
        assert.doesNotMatch(child.stdout + child.stderr, /private-test-token/);
      },
    );
    await t.test(
      "check-image-api command verifies TLS without browser start or generation",
      async () => {
        const before = requests.length;
        const child = await execute(
          process.execPath,
          ["scripts/check-image-api.js"],
          {
            cwd: path.join(__dirname, ".."),
            env: {
              ...process.env,
              GROQ_API_KEY: "test-groq",
              IMAGE_API_KEY: "private-test-token",
              IMAGE_API_BASE_URL: settings.imageBase,
              IMAGE_API_CA_FILE: path.join(directory, "ca root.crt"),
              IMAGE_API_CA_CERT: "",
            },
            timeout: 10000,
          },
        );
        assert.match(child.stdout, /connection and read permission: OK/);
        assert.doesNotMatch(child.stdout + child.stderr, /private-test-token/);
        assert.deepEqual(requests.slice(before), [
          { method: "GET", url: "/api/v1/health" },
          { method: "GET", url: "/api/v1/browser/status" },
        ]);
      },
    );
    await t.test("trusted CA still rejects a wrong hostname", async () => {
      const wrong = await start("dns");
      await withClient(
        {
          imageBase: wrong + "/api/v1",
          imageCa: imageCertificates({ IMAGE_API_CA_CERT: pem }),
        },
        (api) =>
          assert.rejects(
            api.start(),
            (e) =>
              e.code === "UPSTREAM_TLS" && /does not match/.test(e.message),
          ),
      );
    });
    await t.test(
      "missing, malformed and private-key files fail clearly without leaking file contents",
      async () => {
        for (const env of [
          { IMAGE_API_CA_FILE: "missing.crt" },
          { IMAGE_API_CA_CERT: "private-sensitive-garbage" },
          {
            IMAGE_API_CA_CERT:
              "-----BEGIN PRIVATE KEY-----\nprivate-sensitive-key\n-----END PRIVATE KEY-----",
          },
        ])
          assert.throws(
            () => imageCertificates(env, directory),
            (e) =>
              e.code === "PROMOTION_TLS_CONFIG" &&
              !e.message.includes("private-sensitive"),
          );
        assert.deepEqual(
          imageCertificates({
            NODE_EXTRA_CA_CERTS: path.join(directory, "ca root.crt"),
          }),
          imageCertificates({ IMAGE_API_CA_CERT: pem }),
        );
      },
    );
  },
);
