#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then echo 'Usage: scripts/backup.sh ABSOLUTE_DATA_DIR ABSOLUTE_BACKUP_DIR (MONGODB_URI must be set)' >&2; exit 1; fi
: "${MONGODB_URI:?Set MONGODB_URI in the service shell}"
[[ $1 = /* && $2 = /* ]] || { echo 'Absolute paths required'; exit 1; }
command -v mongodump >/dev/null
# Stop API and worker first for a consistent profile/database/files backup.
if pm2 jlist | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.exit(JSON.parse(s).some(p=>["gemini-api","gemini-worker"].includes(p.name)&&p.pm2_env.status==="online")?0:1))'; then echo 'Stop API and worker before backup.' >&2; exit 1; fi
backup_dir="$2/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 0700 -p "$backup_dir"
backup_config=$(mktemp)
trap 'rm -f "$backup_config"' EXIT
node - "$backup_config" <<'JS'
const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({uri:process.env.MONGODB_URI}),{mode:0o600});
JS
mongodump --config="$backup_config" --archive="$backup_dir/database.archive.gz" --gzip
tar --exclude=worker.lock -czf "$backup_dir/runtime.tar.gz" -C "$1" .
sha256sum "$backup_dir/database.archive.gz" "$backup_dir/runtime.tar.gz" > "$backup_dir/SHA256SUMS"
echo "Backup saved: $backup_dir. Encrypt before copying off-host; browser profiles contain credentials."
