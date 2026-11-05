const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { clients } = require("../services/promotionClients");

test("upstream diagnostics identify the denied action and scope without echoing secrets", async (t) => {
  let status = 403,
    body = { error: "API scope required: browser" };
  const server = http.createServer(async (req, res) => {
    for await (const ignored of req) {
      void ignored;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = clients({
    imageBase: base,
    groqBase: base,
    imageKey: "private-image-token",
    groqKey: "private-groq-key",
    requestMs: 1000,
    maxBytes: 1024,
  });
  const fails = async (action, match) =>
    assert.rejects(action(), (error) => {
      assert.equal(error.code, "UPSTREAM_HTTP");
      assert.match(error.message, match);
      assert.doesNotMatch(
        error.message,
        /private-|injected upstream|Authorization/,
      );
      return true;
    });
  await fails(
    () => api.start(),
    /Image API browser start returned HTTP 403.*requires the browser scope/,
  );
  body = { error: "API scope required: generate" };
  await fails(
    () => api.submit("prompt", [], "test-key"),
    /generation submission.*requires the generate scope/,
  );
  body = { error: "API scope required: read" };
  await fails(
    () => api.status("job-123"),
    /job status.*requires the read scope/,
  );
  await fails(
    () => api.download("job-123"),
    /image download.*requires the read scope/,
  );
  body = { error: "Unexpected host. Check PUBLIC_ORIGIN." };
  await fails(() => api.start(), /PUBLIC_ORIGIN host and port/);
  body = { error: "HTTPS is required" };
  await fails(() => api.start(), /requires HTTPS/);
  body = { error: "injected upstream Authorization private-secret" };
  await fails(() => api.start(), /required scope: browser/);
  status = 401;
  await fails(() => api.start(), /Check IMAGE_API_KEY/);
  await fails(() => api.prompt({}, 0, []), /Check GROQ_API_KEY/);
  status = 403;
  body = { error: "private-".repeat(4000) };
  await fails(() => api.start(), /required scope: browser/);
});
