#!/usr/bin/env bash
# LessonDesk V7.1: upgrade an existing V7.0.3 Worker. NO migrations, no init, no test-data import.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
umask 077
stop(){ echo "[STOP] $*" >&2; exit 2; }
[ "${CONFIRM_LIVE_UPDATE:-}" = "YES" ] || stop 'Explicit approval required: CONFIRM_LIVE_UPDATE=YES'
for v in EXPECTED_WORKER_NAME EXPECTED_D1_ID EXPECTED_R2_BUCKET EXPECTED_SITE_URL; do
  [ -n "${!v:-}" ] || stop "Missing environment variable: $v"
done
[ "$EXPECTED_SITE_URL" = 'https://example.com' ] || stop 'Unexpected production hostname'
python3 - <<'PYCHK'
import os,json
c=json.load(open('wrangler.jsonc'))
assert c['name']==os.environ['EXPECTED_WORKER_NAME'],'Worker name mismatch'
assert len(c['d1_databases'])==1 and c['d1_databases'][0]['database_id']==os.environ['EXPECTED_D1_ID'],'D1 ID mismatch'
assert len(c['r2_buckets'])==1 and c['r2_buckets'][0]['bucket_name']==os.environ['EXPECTED_R2_BUCKET'],'R2 bucket mismatch'
print('[OK] Worker, D1 and R2 resource IDs matched')
PYCHK
if [ ! -d node_modules ];then npm install --no-audit --no-fund;fi
npm run check
npm test
npx wrangler whoami
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
before="backups/V7.1-before-$stamp.sql"
count_sql='SELECT (SELECT COUNT(*) FROM campus) AS campuses,(SELECT COUNT(*) FROM student) AS students,(SELECT COALESCE(SUM(lessons_remaining),0) FROM student) AS balance,(SELECT COUNT(*) FROM class_group) AS classes,(SELECT COUNT(*) FROM lesson_record) AS lessons,(SELECT COUNT(*) FROM artwork) AS artworks;'
echo '[1/5] Check schema contract and production data before deployment'
npx wrangler d1 execute DB --remote --json --command='SELECT major,minor FROM data_contract WHERE id=1;' > "backups/V7.1-schema-$stamp.json"
python3 - "backups/V7.1-schema-$stamp.json" <<'PYVER'
import json,sys
j=json.load(open(sys.argv[1]));row=j[0]['results'][0]
assert j[0]['success'] and row['major']==7, 'Incompatible D1 schema: STOP (expected V7)'
print('[OK] D1 schema contract',row)
PYVER
npx wrangler d1 execute DB --remote --json --command="$count_sql" > "backups/V7.1-before-$stamp.json"
echo '[2/5] Backup COMPLETE existing D1 before code deployment'
npx wrangler d1 export DB --remote --output "$before"
[ -s "$before" ] || stop 'D1 backup was not created'
chmod 600 "$before"
sha256sum "$before" > "$before.sha256"
echo '[3/5] Deploy application code and static files ONLY'
npx wrangler deploy
echo '[4/5] Verify D1 remained unchanged'
npx wrangler d1 execute DB --remote --json --command="$count_sql" > "backups/V7.1-after-$stamp.json"
python3 - "backups/V7.1-before-$stamp.json" "backups/V7.1-after-$stamp.json" <<'PYCOMPARE'
import json,sys
rows=[]
for fn in sys.argv[1:]:
 a=json.load(open(fn))
 assert a and a[0].get('success') and a[0].get('results'), 'Invalid Wrangler data: '+fn
 rows.append(a[0]['results'][0])
if rows[0]!=rows[1]:raise SystemExit('STOP: D1 totals changed during code-only deployment! Investigate before further use. '+str(rows))
print('[OK] student, class, record, artwork counts and total balance unchanged:',rows[1])
PYCOMPARE
echo '[5/5] HTTP smoke tests'
curl --fail --silent --show-error --max-time 30 "$EXPECTED_SITE_URL/health" >/dev/null || stop 'Health endpoint not reachable after deploy'
login_code="$(curl --max-time 30 -s -o /dev/null -w '%{http_code}' "$EXPECTED_SITE_URL/login/")"
[ "$login_code" = 200 ] || stop "Expected /login/ 200, got $login_code"
printf '[DEPLOYED - HUMAN ACCEPTANCE STILL REQUIRED] Complete D1 backup: %s\n' "$before"
echo 'Next: test privileged routes + real iPhone media upload, then rename campus via UI after verifying its ID.'
