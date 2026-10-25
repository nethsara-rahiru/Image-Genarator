import { z } from "zod";
import path from "node:path";
export function configuration(env = process.env) {
  const schema = z.object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("production"),
    HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGODB_URI: z.string().startsWith("mongodb"),
    SESSION_SECRET: z.string().min(32),
    PUBLIC_ORIGIN: z
      .url()
      .refine((v) => new URL(v).protocol === "https:", "HTTPS origin required"),
    DATA_DIR: z.string().default("./runtime"),
    GROQ_API_KEY: z.string().default(""),
    GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
    GENERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240000),
    LEASE_MS: z.coerce.number().int().min(5000).default(30000),
    TLS_KEY: z.string().default(""),
    TLS_CERT: z.string().default(""),
  });
  const c = schema.parse(env);
  const origin = new URL(c.PUBLIC_ORIGIN);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without credentials, path or query",
    );
  c.PUBLIC_ORIGIN = origin.origin;
  c.DATA_DIR = path.resolve(c.DATA_DIR);
  const publicDirectory = path.resolve(
    new URL("../../client", import.meta.url).pathname,
  );
  const rel = path.relative(publicDirectory, c.DATA_DIR);
  if (
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  )
    throw new Error("DATA_DIR must be outside the public client directory");
  if (c.DATA_DIR === path.parse(c.DATA_DIR).root)
    throw new Error("DATA_DIR cannot be a filesystem root");
  return c;
}
