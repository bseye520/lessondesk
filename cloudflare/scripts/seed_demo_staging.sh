#!/usr/bin/env bash
# Safe demonstration data creation: refuses production-named databases.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${CONFIRM_DEMO_STAGING:-}" != "YES" ];then echo '测试数据只能进入独立测试库；请设 CONFIRM_DEMO_STAGING=YES' >&2; exit 2;fi
if ! grep -q '"database_name"[[:space:]]*:[[:space:]]*"lessondesk-test' wrangler.jsonc; then
 echo '拒绝：当前 wrangler.jsonc 未绑定以 lessondesk-test 开头的独立测试库，不能导入演示数据。' >&2; exit 2;
fi
if ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"[^"[:space:]]*(test|staging)[^"[:space:]]*"' wrangler.jsonc; then
 echo '拒绝：测试 Worker 的 name 必须包含 test 或 staging，并使用独立的域名。' >&2; exit 2;
fi
npx wrangler d1 execute DB --remote --file=./scripts/seed_demo.sql
printf '已在独立测试 D1 库写入演示课程3个、班级3个、学员18名。\n'
