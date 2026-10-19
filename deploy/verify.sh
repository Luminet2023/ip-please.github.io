#!/usr/bin/env bash
# 线上验收脚本：健康检查、鉴权双信封、CORS、Keycloak 客户端基础配置。
#
# 用法：
#   bash deploy/verify.sh
#   API_BASE=https://api.luminet.cn/anthropic/v1 GAME_ORIGIN=https://www.fuckanthropic.dev bash deploy/verify.sh
set -uo pipefail

API_BASE="${API_BASE:-https://api.luminet.cn/anthropic/v1}"
GAME_ORIGIN="${GAME_ORIGIN:-https://www.fuckanthropic.dev}"
AUTH_BASE="${AUTH_BASE:-https://auth.luminet.cn/realms/prod/protocol/openid-connect}"
CLIENT_ID="${CLIENT_ID:-app_vXmK3nB7cmKcW6q7}"

pass=0
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  FAIL %s（期望 %s，实际 %s）\n' "$name" "$expected" "${actual:-<空>}"
    fail=$((fail + 1))
  fi
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "== 1. 健康检查 =="
status="$(curl -sS -o "$tmpdir/health.json" -w '%{http_code}' "$API_BASE/health" 2>/dev/null || echo 000)"
check "GET /health 返回 200" 200 "$status"
check "健康检查带 no-store" "no-store" \
  "$(curl -sS -D - -o /dev/null "$API_BASE/health" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
echo "       body: $(head -c 200 "$tmpdir/health.json" 2>/dev/null)"
if grep -qi '<!doctype html>' "$tmpdir/health.json" 2>/dev/null; then
  echo "  提示：/anthropic/ 返回的是站点 HTML 而不是后端 JSON，说明反向代理没有把"
  echo "        /anthropic/ 转发到后端容器（检查 nginx location /anthropic/，以及容器是否在"
  echo "        127.0.0.1:8080 监听：curl http://127.0.0.1:8080/anthropic/v1/health）。"
fi


echo "== 2. 鉴权错误信封 =="
status="$(curl -sS -o "$tmpdir/unauth.json" -w '%{http_code}' "$API_BASE/sync/save" 2>/dev/null || echo 000)"
check "无 Token 访问 /sync/save 返回 401" 401 "$status"
check "返回 DetailErrorResponse" '{"detail":"Unauthorized"}' "$(tr -d '\n' < "$tmpdir/unauth.json" 2>/dev/null)"

status="$(curl -sS -o "$tmpdir/badtoken.json" -w '%{http_code}' -H 'Authorization: Bearer invalid.token.value' "$API_BASE/sync/save" 2>/dev/null || echo 000)"
check "非法 Token 返回 401" 401 "$status"
if grep -q '"code":"invalid_token"' "$tmpdir/badtoken.json" 2>/dev/null; then
  echo "  ok   返回 AuthErrorResponse(invalid_token)"
  pass=$((pass + 1))
else
  echo "  FAIL 未返回 invalid_token 信封：$(head -c 200 "$tmpdir/badtoken.json" 2>/dev/null)"
  fail=$((fail + 1))
fi

echo "== 3. CORS 预检 =="
cors_headers="$(curl -sS -X OPTIONS -o /dev/null -D - \
  -H "Origin: $GAME_ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  "$API_BASE/sync/save" 2>/dev/null | tr -d '\r')"
acao="$(printf '%s\n' "$cors_headers" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
check "预检允许 $GAME_ORIGIN" "$GAME_ORIGIN" "$acao"
allow_headers="$(printf '%s\n' "$cors_headers" | awk -F': ' 'tolower($1)=="access-control-allow-headers"{print $2}')"
if printf '%s' "$allow_headers" | grep -qi 'authorization'; then
  echo "  ok   Access-Control-Allow-Headers 含 authorization"
  pass=$((pass + 1))
else
  echo "  FAIL Access-Control-Allow-Headers 缺少 authorization：$allow_headers"
  fail=$((fail + 1))
fi

echo "== 4. Keycloak 客户端配置 =="
auth_status="$(curl -sS -o "$tmpdir/auth.html" -w '%{http_code}' -G \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$GAME_ORIGIN/" \
  --data-urlencode 'response_type=code' \
  --data-urlencode 'scope=openid profile email offline_access' \
  --data-urlencode 'state=verify' \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "$AUTH_BASE/auth" 2>/dev/null || echo 000)"
if [[ "$auth_status" == "302" || "$auth_status" == "200" ]]; then
  echo "  ok   授权端点接受回调 $GAME_ORIGIN/（$auth_status）"
  pass=$((pass + 1))
else
  echo "  FAIL 授权端点拒绝了回调地址（$auth_status），请在 Keycloak 配置 Valid redirect URIs"
  fail=$((fail + 1))
fi

origin_status="$(curl -sS -o "$tmpdir/token.json" -w '%{http_code}' \
  -H "Origin: $GAME_ORIGIN" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode 'refresh_token=bogus' \
  "$AUTH_BASE/token" 2>/dev/null || echo 000)"
if grep -q 'Invalid origin' "$tmpdir/token.json" 2>/dev/null; then
  echo "  FAIL token 端点拒绝 Origin，请在 Keycloak 客户端补 Web Origins: $GAME_ORIGIN"
  fail=$((fail + 1))
else
  echo "  ok   token 端点接受 Origin（$origin_status）"
  pass=$((pass + 1))
fi

echo
echo "== 结果：$pass 通过，$fail 失败 =="
if [[ "$fail" -gt 0 ]]; then
  echo "按上面提示修复后重跑本脚本。"
  exit 1
fi
echo "线上验收全部通过。"
