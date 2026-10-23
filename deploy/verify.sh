#!/usr/bin/env bash
# 线上验收脚本：健康检查、鉴权双信封、CORS、/auth/* 契约、Keycloak 机密客户端。
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

echo "== 4. 登录接口（后端换码） =="
challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
status="$(curl -sS -o "$tmpdir/login.json" -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $GAME_ORIGIN" \
  -d "{\"login_challenge\":\"$challenge\",\"redirect_uri\":\"$GAME_ORIGIN/\"}" \
  "$API_BASE/auth/login" 2>/dev/null || echo 000)"
check "POST /auth/login 返回 200" 200 "$status"
authorize_url="$(sed -n 's/.*"authorize_url":"\([^"]*\)".*/\1/p' "$tmpdir/login.json" 2>/dev/null)"
if [[ "$authorize_url" == "${AUTH_BASE}/auth?"* ]] \
  && [[ "$authorize_url" == *"code_challenge_method=S256"* ]] \
  && [[ "$authorize_url" == *"nonce="* ]]; then
  echo "  ok   authorize_url 指向 IdP 且带 S256 与 nonce"
  pass=$((pass + 1))
else
  echo "  FAIL authorize_url 异常：${authorize_url:-$(head -c 200 "$tmpdir/login.json")}"
  fail=$((fail + 1))
fi
if [[ -n "$authorize_url" ]]; then
  auth_status="$(curl -sS -o /dev/null -w '%{http_code}' "$authorize_url" 2>/dev/null || echo 000)"
  if [[ "$auth_status" == "302" || "$auth_status" == "200" ]]; then
    echo "  ok   IdP 接受该授权请求（$auth_status）"
    pass=$((pass + 1))
  else
    echo "  FAIL IdP 拒绝了授权请求（$auth_status），检查 Valid redirect URIs 与 OIDC_REDIRECT_URIS"
    fail=$((fail + 1))
  fi
fi

status="$(curl -sS -o "$tmpdir/cb.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"code":"x","state":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","login_verifier":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  "$API_BASE/auth/callback" 2>/dev/null || echo 000)"
check "伪造回调返回 400" 400 "$status"
check "伪造回调为 Detail 信封" '{"detail":"The login attempt is invalid or has expired."}' "$(tr -d '\n' < "$tmpdir/cb.json" 2>/dev/null)"

status="$(curl -sS -o "$tmpdir/refresh.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"refresh_token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' "$API_BASE/auth/refresh" 2>/dev/null || echo 000)"
check "未知 RT 刷新返回 401" 401 "$status"
if grep -q '"code":"token_revoked"' "$tmpdir/refresh.json" 2>/dev/null; then
  echo "  ok   未知 RT 返回 token_revoked"
  pass=$((pass + 1))
else
  echo "  FAIL 未知 RT 未返回 token_revoked：$(head -c 200 "$tmpdir/refresh.json" 2>/dev/null)"
  fail=$((fail + 1))
fi

status="$(curl -sS -o "$tmpdir/bcl.json" -w '%{http_code}' -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' --data 'logout_token=not.a.jwt' \
  "$API_BASE/auth/backchannel-logout" 2>/dev/null || echo 000)"
check "反向通道注销拒绝伪造 Token（400）" 400 "$status"
check "反向通道注销返回 JSON 信封" '{"detail":"The request is invalid."}' "$(tr -d '\n' < "$tmpdir/bcl.json" 2>/dev/null)"

cors_headers="$(curl -sS -X OPTIONS -o /dev/null -D - \
  -H "Origin: $GAME_ORIGIN" -H "Access-Control-Request-Method: POST" \
  -H 'Access-Control-Request-Headers: content-type' \
  "$API_BASE/auth/refresh" 2>/dev/null | tr -d '\r')"
check "/auth/refresh 预检允许 $GAME_ORIGIN" "$GAME_ORIGIN" \
  "$(printf '%s\n' "$cors_headers" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"

echo "== 5. Keycloak 客户端为机密客户端 =="
kc_status="$(curl -sS -o "$tmpdir/kc.json" -w '%{http_code}' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode 'code=bogus' \
  --data-urlencode "redirect_uri=$GAME_ORIGIN/" \
  "$AUTH_BASE/token" 2>/dev/null || echo 000)"
if grep -qE '"error":"(unauthorized_client|invalid_client)"' "$tmpdir/kc.json" 2>/dev/null; then
  echo "  ok   只带 client_id 无法换码（机密客户端，$kc_status）"
  pass=$((pass + 1))
else
  echo "  WARN 只带 client_id 的换码没有被当作未认证客户端拒绝：$(head -c 160 "$tmpdir/kc.json" 2>/dev/null)"
  echo "       客户端可能仍是公共客户端（切换期可接受；完成第 4 节后应变为 ok）"
fi

echo
echo "== 结果：$pass 通过，$fail 失败 =="
if [[ "$fail" -gt 0 ]]; then
  echo "按上面提示修复后重跑本脚本。"
  exit 1
fi
echo "线上验收全部通过。"
