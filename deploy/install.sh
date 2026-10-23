#!/usr/bin/env bash
# 服务器初始化 / 更新脚本。
#
# 用法（在服务器上执行）：
#   curl -fsSL https://raw.githubusercontent.com/Luminet2023/ip-please.github.io/main/deploy/install.sh | bash
# 或克隆仓库后：bash deploy/install.sh
#
# 首次运行会生成 /opt/ip-please-sync/.env 并退出，编辑填入 SYNC_DATABASE_URL 后再运行一次即可。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ip-please-sync}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/Luminet2023/ip-please.github.io/main/deploy}"
HEALTH_URL="http://127.0.0.1:8080/anthropic/v1/health"

mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [[ ! -f docker-compose.yml ]]; then
  echo "==> 获取 docker-compose.yml"
  curl -fsSLO "$REPO_RAW/docker-compose.yml"
fi

if [[ ! -f .env ]]; then
  echo "==> 生成 .env 模板"
  curl -fsSL "$REPO_RAW/.env.example" -o .env
  chmod 600 .env
  # 自动生成签名密钥（只在首次生成 .env 时执行）
  for key in SESSION_JWT_SECRET ENDLESS_SEED_SECRET; do
    sed -i "s|^${key}=CHANGE_ME\$|${key}=$(openssl rand -hex 32)|" .env
  done
  cat <<'EOF'

已生成 .env。请编辑并至少填写：

  SYNC_DATABASE_URL=mysql://用户名:密码@host:3306/库名

（复用服务器现有 MySQL；服务只会创建 ip_please_* 前缀的表，账号需要有 CREATE 权限。）
保存后重新执行本脚本即可完成部署。
EOF
  exit 0
fi

if ! grep -qE '^SYNC_DATABASE_URL=mysql://.+' .env || grep -q 'USER:PASSWORD' .env; then
  echo "错误：$APP_DIR/.env 中的 SYNC_DATABASE_URL 还没填好。" >&2
  echo "示例：SYNC_DATABASE_URL=mysql://sync:password@127.0.0.1:3306/game" >&2
  exit 1
fi

# 旧版 .env（升级前生成）没有密钥：补上，不覆盖已有值
for key in SESSION_JWT_SECRET ENDLESS_SEED_SECRET; do
  if ! grep -qE "^${key}=.{32,}" .env || grep -qE "^${key}=CHANGE_ME" .env; then
    echo "==> 生成 ${key}"
    sed -i "/^${key}=/d" .env
    echo "${key}=$(openssl rand -hex 32)" >> .env
  fi
done

command -v docker >/dev/null 2>&1 || { echo "错误：未安装 docker。" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "错误：需要 docker compose v2（docker compose 子命令）。" >&2; exit 1; }

echo "==> 拉取镜像"
docker compose pull

echo "==> 启动"
docker compose up -d

echo "==> 等待健康检查（最长 120 秒）"
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "容器已就绪：$(curl -sS "$HEALTH_URL")"
    cat <<'EOF'

下一步：
1) 为 api.luminet.cn 增加 nginx 反代（保留 /anthropic/ 前缀，见 deploy/README.md）。
2) 在任意机器运行 deploy/verify.sh 做线上验收。
3) 按 deploy/README.md 第 4 节配置 Keycloak：机密客户端、反向通道注销 URL、管理员角色，
   把客户端 secret 填进 .env 的 OIDC_CLIENT_SECRET 后重新执行本脚本。
EOF
    exit 0
  fi
  sleep 2
done

echo "健康检查超时。最近日志：" >&2
docker compose logs --tail=80 >&2
exit 1
