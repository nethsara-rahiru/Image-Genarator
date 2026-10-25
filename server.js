import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import mongoose from "mongoose";
import { configuration } from "./src/config/index.js";
import { connect, Setting } from "./src/models/index.js";
import { storage } from "./src/utils/files.js";
import { createApp } from "./src/app.js";
import { BrowserManager } from "./src/services/browserManager.js";
import { AccountManager } from "./src/services/accountManager.js";
import { attachViewer } from "./src/services/loginViewer.js";
process.umask(0o077);
const config = configuration();
await storage(config);
await connect(config.MONGODB_URI);
await Setting.updateOne(
  { _id: "global" },
  {
    $setOnInsert: {
      generationTimeoutMs: config.GENERATION_TIMEOUT_MS,
      groqModel: config.GROQ_MODEL,
    },
  },
  { upsert: true },
);
const browsers = new BrowserManager(config);
const accounts = new AccountManager(browsers);
const { app, sessionMiddleware, sessionStore } = createApp(config, accounts);
const server =
  config.TLS_KEY && config.TLS_CERT
    ? https.createServer(
        {
          key: fs.readFileSync(config.TLS_KEY),
          cert: fs.readFileSync(config.TLS_CERT),
        },
        app,
      )
    : http.createServer(app);
const viewers = attachViewer(server, sessionMiddleware, accounts, config);
server.listen(config.PORT, config.HOST, () =>
  console.log(
    JSON.stringify({
      event: "api.listening",
      host: config.HOST,
      port: config.PORT,
    }),
  ),
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  for (const ws of viewers.clients) ws.terminate();
  viewers.close();
  server.close();
  await accounts.close();
  await browsers.close();
  await sessionStore.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
