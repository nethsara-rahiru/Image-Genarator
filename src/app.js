import express from "express";
import { companionRoutes } from "./routes/companion.js";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secureTransport, csrf } from "./middleware/security.js";
import { errorHandler } from "./utils/errors.js";
import { routes } from "./routes/api.js";
export function createApp(config, accounts, { store } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(secureTransport(config));
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/companion", companionRoutes(config));
  const sessionStore =
    store || MongoStore.create({ mongoUrl: config.MONGODB_URI, ttl: 3600 });
  const sessionMiddleware = session({
    name: "gemini.sid",
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 3600000,
    },
  });
  app.use(sessionMiddleware);
  app.use(csrf);
  app.use("/api", routes(config, accounts));
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } }),
  );
  app.use(
    express.static(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../client"),
      { index: "index.html", maxAge: 0 },
    ),
  );
  app.use(errorHandler);
  return { app, sessionMiddleware, sessionStore };
}
