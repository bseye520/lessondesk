#!/usr/bin/env bash
# 无须登录的最基础远端 HTTP 检查；不会修改远程数据
set -euo pipefail
if [[ $# -ne 1 ]]; then echo '用法: bash scripts/smoke_remote.sh https://worker.example.com' >&2; exit 2; fi
base="${1%/}"
if [[ "$base" != https://* ]]; then echo '仅接受 HTTPS 站点，正式部署不允许 HTTP' >&2; exit 2; fi
check(){
  expected="$1"; path="$2";
  actual="$(curl --max-time 20 --silent --output /dev/null --write-out '%{http_code}' "$base$path")"
  if [[ "$actual" != "$expected" ]]; then echo "❌ $path 期望 $expected 实际 $actual"; exit 1; fi
  echo "✅ $path HTTP $actual"
}
check 200 /health
check 200 /login
check 200 /manifest.webmanifest
check 200 /css/design-system.css
check 200 /css/style.css
check 200 /icons/icon-192.png
check 401 /
check 404 /p/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
printf '\n远端基础只读检查通过。还需人工进行教师、课时、图片、家长页面与报名完整验收。\n'
