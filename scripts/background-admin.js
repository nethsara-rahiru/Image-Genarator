import path from "node:path";
import { configuration } from "../src/config.js";
import { interactiveAdmin } from "./admin.js";
process.umask(0o077);
const config = configuration();
await interactiveAdmin(
  { ...config, data: path.join(config.data, "background") },
  true,
);
