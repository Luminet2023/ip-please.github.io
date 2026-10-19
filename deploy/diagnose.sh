#!/usr/bin/env bash
# 服务器端诊断：确认容器、端口、nginx 配置与公网链路。
#
# 用法（在服务器上执行，输出可整段贴回来）：
#   bash deploy/diagnose.sh
#
# 说明：只读检查，不修改任何配置。
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/ip-please-sync}"
DOMAIN="${DOMAIN:-api.luminet.cn}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080/anthropic/v1/health}"

section() { printf '\n=== %s ===\n' "$1"; }
run() { printf '$ %s\n' "$*"; "$@" 2>&1 || true; }

section "1. 容器状态"
if [ -d "$APP_DIR" ]; then
  (cd "$APP_DIR" && run docker compose ps && echo && run docker compose logs --tail=15)
else
  echo "目录不存在：$APP_DIR"
fi

section "2. 本机后端健康检查"
run curl -sS -m 5 -D - "$LOCAL_URL"

section "3. 8080 端口监听"
run ss -lntp

section "4. nginx 是否存在 / 配置里与 anthropic 相关的片段"
if command -v nginx >/dev/null 2>&1; then
  run nginx -v
  echo "--- nginx -T 中包含 anthropic 的配置 ---"
  nginx -T 2>/dev/null | grep -n -B3 -A15 'anthropic' || echo "（没有找到包含 anthropic 的配置！）"
  echo "--- 配置测试 ---"
  run nginx -t
else
  echo "本机没有 nginx（可能由 Caddy/Traefik/容器内 nginx 承载）"
  run docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
fi

section "5. 经本机 nginx/代理访问（Host 头模拟）"
run curl -sS -m 8 -o /dev/null -w 'http_host_health=%{http_code}\n' -H "Host: $DOMAIN" "http://127.0.0.1/anthropic/v1/health"
run curl -sS -m 8 -o /dev/null -w 'https_host_health=%{http_code}\n' -k -H "Host: $DOMAIN" "https://127.0.0.1/anthropic/v1/health"

section "6. 公网链路"
run curl -sS -m 10 -o /dev/null -w 'public_health=%{http_code} type=%{content_type}\n' "https://$DOMAIN/anthropic/v1/health"
run curl -sS -m 10 -o /dev/null -w 'public_unauth=%{http_code}\n' "https://$DOMAIN/anthropic/v1/sync/save"
echo "--- 预检响应头 ---"
curl -sS -m 10 -X OPTIONS -D - -o /dev/null \
  -H "Origin: https://www.fuckanthropic.dev" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization" \
  "https://$DOMAIN/anthropic/v1/sync/save" 2>/dev/null | sed 's/\r$//' | grep -iE '^(HTTP|access-control|allow|server)' || true

printf '\n=== 结论参考 ===\n'
printf '健康检查若是 JSON 且公网 401/CORS 头正确，则部署完成；\n'
printf '若是 HTML（<title>Luminet</title>），说明 /anthropic/ 仍被静态 SPA 兜底，检查第 4 节配置。\n'
