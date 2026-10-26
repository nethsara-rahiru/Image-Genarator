import { startCompanion } from "./companion/server.js";
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Node.js 22 or later is required.");
  process.exit(1);
}
const companion = await startCompanion();
console.log(`Gemini local companion: ${companion.url}`);
console.log(
  "Keep this terminal and the paired extension tab open. Google sign-in stays in your browser.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await companion.close();
    process.exit(0);
  });
