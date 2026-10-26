#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
  echo 'Run as your non-root service user (for example dev), with sudo available.' >&2
  exit 1
fi
node --input-type=module -e 'if(Number(process.versions.node.split(".")[0])<22)throw new Error("Install Node.js 22+ first")'
npm ci
npx playwright install --with-deps chromium
mkdir -p runtime
chmod 700 runtime
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
printf '%s\n' 'Dependencies installed. Edit .env, run npm run setup-admin, then node app.js.'
