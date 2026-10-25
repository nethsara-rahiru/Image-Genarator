import { z } from 'zod';
import path from 'node:path';
export function configuration(env = process.env) {
  const schema = z.object({ NODE_ENV:z.enum(['development','test','production']).default('production'), HOST:z.enum(['127.0.0.1','::1']).default('127.0.0.1'), PORT:z.coerce.number().int().min(1).max(65535).default(3000), MONGODB_URI:z.string().startsWith('mongodb'), SESSION_SECRET:z.string().min(32), PUBLIC_ORIGIN:z.url().refine(v=>new URL(v).protocol==='https:','HTTPS origin required'), DATA_DIR:z.string().default('./runtime'), GROQ_API_KEY:z.string().default(''), GROQ_MODEL:z.string().default('llama-3.3-70b-versatile'), GENERATION_TIMEOUT_MS:z.coerce.number().int().min(1000).default(240000), LEASE_MS:z.coerce.number().int().min(5000).default(30000), TLS_KEY:z.string().default(''),TLS_CERT:z.string().default('') });
  const c=schema.parse(env); c.DATA_DIR=path.resolve(c.DATA_DIR); return c;
}
