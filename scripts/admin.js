import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { configuration } from "../src/config.js";
import { readAdmin, writeAdmin } from "../src/admin.js";
if (!process.stdin.isTTY)
  throw new Error(
    "Run in an interactive terminal; do not pass passwords as arguments",
  );
process.umask(0o077);
const config = configuration();
const reset = process.argv.includes("--reset");
const current = await readAdmin(config.data);
let rl;
try {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const username =
    (
      await rl.question(
        `Administrator username${reset && current ? ` [${current.username}]` : ""}: `,
      )
    ).trim() || (reset ? current?.username : "");
  rl.close();
  const silent = new Writable({
    write(chunk, encoding, done) {
      done();
    },
  });
  rl = readline.createInterface({
    input: process.stdin,
    output: silent,
    terminal: true,
  });
  process.stdout.write("New password (14+ characters; hidden): ");
  const password = await rl.question("");
  process.stdout.write("\nConfirm password (hidden): ");
  const confirm = await rl.question("");
  process.stdout.write("\n");
  if (password !== confirm) throw new Error("Passwords do not match");
  await writeAdmin(config.data, username, password, reset);
  console.log(
    `Administrator ${reset ? "reset" : "created"}: ${username}. Existing sessions are invalidated.`,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  rl?.close();
}
