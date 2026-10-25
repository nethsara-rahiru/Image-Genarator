import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const b of buffer) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    chunks.push(header, filename, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, filename);
    offset += header.length + filename.length + data.length;
  }
  const c = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, c, end]);
}
export async function companionArchive() {
  const files = [
    [
      "package.json",
      Buffer.from(
        JSON.stringify({
          name: "gemini-local-companion",
          private: true,
          type: "module",
          engines: { node: ">=22" },
        }),
      ),
    ],
    [
      "START-HERE.txt",
      Buffer.from(
        "Install Node.js 22+. Extract this entire folder. Open a terminal here and run: node app.js\nFollow the local setup page. Install extension/ through Chrome or Edge Load unpacked once per browser profile. Keep the companion terminal and extension tab open. Pair only your own trusted HTTPS VPS. Google credentials/cookies stay in the browser.\n",
      ),
    ],
  ];
  const paths = [
    "app.js",
    "companion/server.js",
    "companion/transport.js",
    "companion/files.js",
    "companion/broker.js",
    "companion/agent.js",
    "companion/public/index.html",
    "companion/public/app.js",
    "companion/public/style.css",
    "extension/manifest.json",
    "extension/background.js",
    "extension/bridge.js",
    "extension/engine.js",
    "extension/content.js",
    "extension/companion.html",
    "extension/style.css",
  ];
  for (const relative of paths)
    files.push([relative, await fs.readFile(path.join(root, relative))]);
  return zipFiles(files);
}
