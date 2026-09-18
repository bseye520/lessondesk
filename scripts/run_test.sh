#!/usr/bin/env bash
# 课时本本地测试：起一个临时实例（独立临时库）→ 跑全链路冒烟
#
# 用法：./scripts/run_test.sh [端口]
#
# 依赖：python3（建议 3.11+）。首次运行会在 /tmp/ld-venv 建虚拟环境装依赖。
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-28012}"
TMP="${LD_TEST_DIR:-/tmp/ldtest}"   # 临时实例目录（独立数据库，不动你自己的数据）
# 1) 挑 Python 环境：当前解释器已有依赖就直接用，否则建虚拟环境
if python3 -c "import flask, gunicorn, openpyxl" 2>/dev/null; then
  PYBIN="$(command -v python3)"
  GUNICORN="$(command -v gunicorn)"
  echo "==> 使用当前 Python 环境: $PYBIN"
else
  VENV="${LD_TEST_VENV:-/tmp/ld-venv}"
  if [ ! -x "$VENV/bin/python" ]; then
    echo "==> 创建虚拟环境 $VENV"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q -r requirements.txt
  fi
  PYBIN="$VENV/bin/python"
  GUNICORN="$VENV/bin/gunicorn"
fi

# 2) 杀掉占用该端口的旧进程
for pid in $(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

# 3) 全新临时库起服务
rm -rf "$TMP" && mkdir -p "$TMP"
echo "==> 启动测试实例 127.0.0.1:$PORT（库=$TMP）"
SECRET_KEY="${SECRET_KEY:-testkey1234567890}" \
  setsid "$GUNICORN" -w 1 --threads 8 --timeout 60 \
  --bind "127.0.0.1:$PORT" "app:create_app('$TMP')" \
  > "$TMP/gunicorn.log" 2>&1 &

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null \
  && echo "==> 服务就绪 http://127.0.0.1:$PORT" \
  || { echo "!! 服务未能启动，日志："; cat "$TMP/gunicorn.log"; exit 1; }

# 4) 冒烟
"$PYBIN" scripts/smoke.py "http://127.0.0.1:$PORT"
