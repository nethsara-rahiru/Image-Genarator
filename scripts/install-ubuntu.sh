#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run with sudo on Ubuntu 24.04.' >&2; exit 1; fi
if [[ ! -f /etc/os-release ]]; then exit 1; fi
. /etc/os-release
if [[ $ID != ubuntu || $VERSION_ID != 24.04 ]]; then echo 'Supported installer target is Ubuntu 24.04.' >&2; exit 1; fi
apt-get update
apt-get install -y ca-certificates curl gnupg git util-linux openssl build-essential
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then echo 'Install Node.js 22+ from a trusted vendor, then rerun. No remote shell scripts are executed.' >&2; exit 1; fi
id gemini-agent &>/dev/null || useradd --system --create-home --home-dir /opt/gemini-agent --shell /bin/bash gemini-agent
install -d -o gemini-agent -g gemini-agent -m 0700 /opt/gemini-agent/app /opt/gemini-agent/backups
npx playwright install-deps chromium
if ! command -v mongod >/dev/null; then echo 'Install MongoDB 8 and database tools using docs/deployment.md before starting services.'; fi
echo 'Service user prepared. Follow docs/deployment.md to clone, configure TLS and provision administrator.'
