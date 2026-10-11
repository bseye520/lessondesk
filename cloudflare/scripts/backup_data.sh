#!/usr/bin/env bash
# Run from project root after authentication with Wrangler. Stores D1 data and logs, not R2 bytes.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v python3 >/dev/null || { echo 'python3 required'; exit 2; }
# Refuse to run with a placeholder database id.
python3 - <<'PY'
import json
p=json.load(open('wrangler.jsonc'))
assert p['d1_databases'][0]['database_id'] not in ('REPLACE_WITH_D1_DATABASE_ID',''), 'Configure live D1 database id first'
PY
DATE="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-./backups}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
npx wrangler d1 export DB --remote --output "$TMP/data.sql"
python3 scripts/archive_backup.py --input "$TMP/data.sql" --output "$DEST/LessonDesk-V7-$DATE.zip"
echo 'IMPORTANT: Copy/encrypt backup off Cloudflare and test restore before upgrades.'
