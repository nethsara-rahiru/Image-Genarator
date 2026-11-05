const { isOnline } = require("../services/availability");
const message = "Marketing Agent is temporarily unavailable for maintenance.";
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maintenance · Marketing Agent</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#10221d;color:#eff8f3}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(100%,540px);padding:clamp(24px,6vw,48px);border:1px solid #39564a;border-radius:20px;background:#182f26}
.brand{color:#99d6b9;font-weight:650;letter-spacing:.04em}h1{font-size:clamp(28px,6vw,40px);line-height:1.15;margin:24px 0 16px}p{line-height:1.65;color:#cee0d5}small{color:#99b6a5}
</style></head><body><main aria-labelledby="title"><div class="brand">Marketing Agent</div>
<h1 id="title">Under maintenance</h1><p>We’re temporarily offline while maintenance is in progress. Please check back later.</p>
<small>The service will be available again when maintenance is complete.</small></main></body></html>`;
module.exports = function maintenance(req, res, next) {
  if (isOnline()) return next();
  res.set({
    "Cache-Control": "no-store",
    "Retry-After": "60",
    "X-Content-Type-Options": "nosniff",
  });
  if (
    /^\/api(?:\/|$)/i.test(req.path) ||
    req.get("Accept")?.includes("application/json")
  )
    return res.status(503).json({ code: "MAINTENANCE", error: message });
  return res.status(503).type("html").send(page);
};
