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

`api.luminet.cn` 增加一条 location，**保留 `/anthropic/` 前缀**（不要 rewrite 掉）。
仓库里已备好可直接 include 的片段 [`nginx-anthropic.conf`](nginx-anthropic.conf)：

```bash
sudo cp deploy/nginx-anthropic.conf /etc/nginx/snippets/ip-please-anthropic.conf
# 在承载 api.luminet.cn 的 server 块里加：
#     include /etc/nginx/snippets/ip-please-anthropic.conf;
sudo nginx -t && sudo systemctl reload nginx
```

等价配置：

```nginx
location ^~ /anthropic/ {
    proxy_pass http://127.0.0.1:8080;      # 不要带路径
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 1m;               # 大于 SYNC_MAX_PAYLOAD_BYTES 即可
    proxy_request_buffering off;           # 让 413 语义透传
    proxy_read_timeout 30s;
}
```

**常见错误**（会表现为浏览器 CORS 报错或 `/anthropic/…` 返回 HTML）：

1. 用 `root` / `alias` / `try_files` / `return 200` 提供静态页 —— 必须是 `proxy_pass` 到 `127.0.0.1:8080`。
2. `proxy_pass` 写了路径（如 `.../anthropic/`）—— URI 被改写，后端路由匹配不到，必须不带路径。
3. 在 location 里用 `if ($request_method = OPTIONS) { return 204; }` 吃掉预检 —— 预检必须转发给后端，否则没有 CORS 头。
4. nginx 里又 `add_header Access-Control-Allow-Origin` —— 后端已返回，重复值会被浏览器拒绝。
5. location 被正则/SPA 兜底抢走 —— 用 `^~` 前缀匹配。

CORS 由服务自身处理（`ALLOWED_ORIGINS`），代理不要重复添加 `Access-Control-Allow-Origin`。

验证：

```bash
curl -sS https://api.luminet.cn/anthropic/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://api.luminet.cn/anthropic/v1/sync/save   # 期望 401
```

排障：服务器上跑 `bash deploy/diagnose.sh`（只读），会打印容器状态、本机健康检查、8080 监听、
nginx 中与 anthropic 相关的配置片段与公网链路结果。

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

## 7. 排障

### 7.1 MySQL 连接失败（日志出现 `pool timed out` / connection refused）

先确认连接串格式。**必须是 sqlx 的 URL，不接受 Go 的 DSN**：

```env
# 正确
SYNC_DATABASE_URL=mysql://user:password@host:3306/database

# 错误（Go 风格，服务启动会直接报 SYNC_DATABASE_URL 格式错误）
MYSQL_DSN=user:password@tcp(127.0.0.1:3306)/database?charset=utf8mb4
```

再确认容器能否到达 MySQL。容器里的 `127.0.0.1` 是容器自己，不是宿主机。

- **MySQL 是宿主机上的进程（127.0.0.1:3306）**
  - 方案 A（推荐）：compose 里加
    ```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ```
    连接串主机写 `host.docker.internal`；同时确认 MySQL 的 `bind-address` 不是仅 `127.0.0.1`
    （宿主机 `ss -lntp | grep 3306` 应能看到 `0.0.0.0:3306` 或 docker0 的地址），否则容器仍连不上。
  - 方案 B：容器用 host 网络（`network_mode: host`，此时 `ports` 映射失效），连接串写
    `127.0.0.1`，并把 `.env` 里 `BIND_ADDR` 改成 `127.0.0.1:8080`，避免端口直接暴露公网。
- **MySQL 在另一个容器里**：compose 里通过 `networks` 加入同一个网络，连接串写容器/服务名，
  例如 `mysql://user:pass@mysql:3306/db`；可用 `docker network inspect <网络>` 确认。
- **MySQL 是远程实例**：直接用其地址，注意防火墙与该用户的 `host` 授权（`'user'@'%'`）。

从容器内验证连通性（镜像自带 curl）：

```bash
docker exec -it ip-please-sync sh -c 'getent hosts host.docker.internal || true'
docker exec -it ip-please-sync sh -c 'curl -sv telnet://host.docker.internal:3306 2>&1 | tail -3'
```

权限：服务启动时会幂等创建 `ip_please_*` 表，账号需要该库的 `CREATE/INDEX/ALTER` 权限。
推荐用 [init-db.sql](init-db.sql) 建独立库与独立账号，不要复用其它项目的密码。

### 7.2 `/anthropic/…` 返回站点 HTML 而不是 JSON

说明反向代理把该前缀当静态资源/SPA 兜底了，而不是 `proxy_pass`。按第 3 节配置，并检查是否误加了
`root`/`alias`/`try_files`/`return 204`/`rewrite`。服务器上跑 `bash deploy/diagnose.sh` 可定位。

