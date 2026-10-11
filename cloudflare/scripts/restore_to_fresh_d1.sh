#!/usr/bin/env bash
# Disaster recovery: deliberately refuse an existing primary D1 id or any nonempty target schema.
set -euo pipefail
if [ "$#" -ne 2 ]; then echo "Usage: $0 BACKUP.zip RESTORE_WRANGLER_CONFIG.jsonc" >&2; exit 2; fi
cd "$(dirname "$0")/.."
ARCHIVE="$(realpath "$1")"
RESTORE_CONFIG="$(realpath "$2")"
[ "${CONFIRM_RESTORE_FRESH:-}" = "YES" ] || { echo 'STOP: set CONFIRM_RESTORE_FRESH=YES only after you have created a NEW EMPTY D1' >&2; exit 2; }
python3 - "$RESTORE_CONFIG" <<'PY'
import json,sys
original=json.load(open('wrangler.jsonc'))['d1_databases'][0]['database_id']
restore=json.load(open(sys.argv[1]))['d1_databases'][0]['database_id']
if not restore or restore=='REPLACE_WITH_D1_DATABASE_ID' or restore==original:raise SystemExit('STOP: target must be a NEW D1 with a different ID; refusing production overwrite')
print('[CHECK] Target is a distinct database id')
PY
TMP="$(mktemp -d)";trap 'rm -rf "$TMP"' EXIT
python3 scripts/archive_backup.py --verify "$ARCHIVE" --extract-sql "$TMP"
# Target must have no business tables. Use Wrangler structured output and fail closed on unparseable output.
npx wrangler d1 execute DB --remote --config "$RESTORE_CONFIG" --json --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('campus','student','lesson_record','operation_log');" > "$TMP/status.json"
python3 - "$TMP/status.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));r=r if isinstance(r,list) else [r]
try:
 assert r and r[0]['success'] and r[0]['results'][0]['n']==0
except (KeyError,IndexError,AssertionError,TypeError):raise SystemExit('STOP: target has tables or its empty-state cannot be verified')
print('[CHECK] Target contains no business tables')
PY
npx wrangler d1 execute DB --remote --config "$RESTORE_CONFIG" --file "$TMP/data.sql"
# Invalidate copied sessions and login rate buckets after a disaster restore.
npx wrangler d1 execute DB --remote --config "$RESTORE_CONFIG" --command='DELETE FROM session; DELETE FROM login_attempt;'
echo '[DONE] D1 restore executed to FRESH target only. Run a new Worker staging deployment and manually check ALL data before switching DNS.'
echo '[NOTICE] R2 image bytes are NOT in this data archive; restore separate manually exported media before declaring completion.'
