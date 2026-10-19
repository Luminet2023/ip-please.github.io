# 云同步部署说明

服务镜像由 GitHub Actions 构建并推送到 GHCR：
`ghcr.io/luminet2023/ip-please-backend:latest`（`linux/amd64,linux/arm64`）。

## 0. 一键脚本（推荐）

服务器上执行；首次运行会生成 `/opt/ip-please-sync/.env` 并退出，编辑填入
`SYNC_DATABASE_URL` 后重新执行即可拉起容器：

```bash
curl -fsSL https://raw.githubusercontent.com/Luminet2023/ip-please.github.io/main/deploy/install.sh | bash
```

配好 nginx 反代后，在任意能访问外网的机器跑验收（会检查健康接口、鉴权双信封、CORS 与
Keycloak 客户端配置，失败退出码非 0）：

```bash
curl -fsSL https://raw.githubusercontent.com/Luminet2023/ip-please.github.io/main/deploy/verify.sh -o verify.sh
bash verify.sh
```

## 1. 服务器准备

```bash
mkdir -p /opt/ip-please-sync && cd /opt/ip-please-sync
cp deploy/docker-compose.yml .
cp deploy/.env.example .env
vi .env            # 填 SYNC_DATABASE_URL 等
```

`.env` 至少需要：

```env
SYNC_DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DATABASE
```

MySQL 账号需要有该库的 `CREATE` 权限：启动时会幂等创建 `ip_please_users`、
`ip_please_save_slots`、`ip_please_save_snapshots` 三张表，不会触碰其他表。

如果 GHCR 包是私有的，先登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github用户名> --password-stdin
```

## 2. 启动

```bash
docker compose pull
docker compose up -d
docker compose logs -f --tail=50
curl -sS http://127.0.0.1:8080/anthropic/v1/health
# 期望：{"status":"ok","db":"ok"}
```

容器只监听 `127.0.0.1:8080`，对外由反向代理暴露。

## 3. 反向代理（nginx 示例）

`api.luminet.cn` 的增加一条 location，**保留 `/anthropic/` 前缀**（不要 rewrite 掉）：

```nginx
location /anthropic/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 1m;          # 大于 SYNC_MAX_PAYLOAD_BYTES 即可
    proxy_request_buffering off;      # 让 413 语义透传
    proxy_read_timeout 30s;
}
```

CORS 由服务自身处理（`ALLOWED_ORIGINS`），代理不要重复添加 `Access-Control-Allow-Origin`。

验证：

```bash
curl -sS https://api.luminet.cn/anthropic/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://api.luminet.cn/anthropic/v1/sync/save   # 期望 401
```

## 4. Keycloak 客户端配置

客户端 `app_vXmK3nB7cmKcW6q7` 必须满足：

| 项 | 值 |
| --- | --- |
| Client authentication | Off（公共客户端） |
| Standard flow | 开 |
| Direct access grants | 关（不需要） |
| Valid redirect URIs | `https://www.fuckanthropic.dev/`（如需本地调试再加 `http://localhost:8000/`） |
| Web origins | `https://www.fuckanthropic.dev`（本地调试加 `http://localhost:8000`） |
| Advanced → Proof Key for Code Exchange Code Challenge Method | `S256` |
| 需要的 scope | `openid profile email offline_access`（`offline_access` 才发 refresh token） |

自检（应返回 302 或登录页，而不是 400 `invalid redirect_uri` / 403 `Invalid origin`）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -G \
  --data-urlencode 'client_id=app_vXmK3nB7cmKcW6q7' \
  --data-urlencode 'redirect_uri=https://www.fuckanthropic.dev/' \
  --data-urlencode 'response_type=code' \
  --data-urlencode 'scope=openid offline_access' \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  https://auth.luminet.cn/realms/prod/protocol/openid-connect/auth
```

## 5. 升级与回滚

```bash
cd /opt/ip-please-sync
docker compose pull
docker compose up -d
```

镜像 tag：`latest`、`sha-<short>`、`build-<sha>`。回滚：把 `.env` 里 `IMAGE_TAG` 改成目标
`sha-<short>` / `build-<short>`（compose 中镜像为 `…:${IMAGE_TAG:-latest}`），再 `docker compose up -d`。

### 可选：GitHub Actions 一键部署

仓库自带 `.github/workflows/deploy.yml`（手动触发）。在仓库 Settings → Secrets 配置：

| Secret | 说明 |
| --- | --- |
| `SSH_HOST` | 服务器地址 |
| `SSH_USER` | SSH 用户 |
| `SSH_KEY` | SSH 私钥全文（ed25519 / rsa） |
| `SSH_PORT` | 可选，默认 22 |

然后 Actions → `deploy-backend` → Run workflow，填写部署目录（默认 `/opt/ip-please-sync`）与镜像 tag。

## 6. 运维要点

- 日志：`docker compose logs -f ip-please-sync`；已限制 `json-file` 10MB × 3。
- 健康检查：容器内 `curl -fsS http://127.0.0.1:8080/anthropic/v1/health`。
- 数据：`ip_please_save_slots` 保存每用户当前进度，`ip_please_save_snapshots` 保留每次日终快照，
  按 `(user_id, version)` 唯一。需要清理历史快照时按 `created_at_ms` 删旧记录即可。
- 限流：单用户上传最小间隔 `SYNC_RATE_LIMIT_SECONDS`（默认 3 秒），内存实现，多副本部署时需换成
  Redis 等共享存储。
