#!/usr/bin/env bash
# Intended for an authenticated NAS scheduler, not inside a Cloudflare Worker.
set -euo pipefail
cd "$(dirname "$0")/.."
month=$(date -u +%m)
if [[ "$month" != "01" && "$month" != "04" && "$month" != "07" && "$month" != "10" ]]; then
 echo 'Not a quarter boundary; nothing to do'; exit 0
fi
bash scripts/backup_data.sh "${1:-./backups}"
if [[ "$month" == "01" ]]; then echo 'This January snapshot also serves as the annual archive: keep it permanently.'; fi
