import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "runtime", "test-results"].includes(entry.name)
    )
      continue;
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|cjs)$/.test(file)) {
      const check = spawnSync(process.execPath, ["--check", file], {
        encoding: "utf8",
      });
      if (check.status) {
        console.error(check.stderr);
        process.exitCode = 1;
      }
    }
  }
}
walk(".");
