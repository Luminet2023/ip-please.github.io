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
3. 用不带 CORS 头的 `if ($request_method = OPTIONS) { return 204; }` 吃掉预检 —— 浏览器会拒绝。
   要由 nginx 应答预检，用下面「可选」里的写法。
4. 正式请求在 nginx 里又 `add_header Access-Control-Allow-Origin`（或打开面板的「跨域」开关）——
   后端已返回，重复值会被浏览器拒绝。
5. location 被正则/SPA 兜底抢走 —— 用 `^~` 前缀匹配。

CORS 由服务自身处理（`ALLOWED_ORIGINS`），代理不要给正式请求重复添加 `Access-Control-Allow-Origin`。

**可选：由 nginx 直接应答预检**（不进后端，`Max-Age` 拉长到 1 天，浏览器各自封顶：Chrome 2 小时、
Firefox 24 小时、Safari 10 分钟）。放在上面 location 的最前面；来源正则要与 `ALLOWED_ORIGINS` 一致，
不在名单里的来源照常转给后端拒绝：

```nginx
    set $ipp_preflight "$request_method $http_origin";
    if ($ipp_preflight ~* "^OPTIONS (https://(www\.)?fuckanthropic\.dev|http://localhost:8000)$") {
        add_header Access-Control-Allow-Origin $http_origin always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept" always;
        add_header Access-Control-Max-Age 86400 always;
        add_header Vary Origin always;
        return 204;
    }
```

验证：

```bash
curl -sS https://api.luminet.cn/anthropic/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://api.luminet.cn/anthropic/v1/sync/save   # 期望 401
```

排障：服务器上跑 `bash deploy/diagnose.sh`（只读），会打印容器状态、本机健康检查、8080 监听、
nginx 中与 anthropic 相关的配置片段与公网链路结果。

## 4. Keycloak 客户端配置

浏览器只跳转授权页；换码、校验 ID Token 都由后端完成，后端签发本服务自己的 AT / RT（会话 `sess_*`）。
客户端 `app_vXmK3nB7cmKcW6q7` 按下表配置：

| 项 | 值 |
| --- | --- |
| Client authentication | **On**（机密客户端）；Credentials 页的 secret 填进 `.env` 的 `OIDC_CLIENT_SECRET` |
| Standard flow | 开 |
| Direct access grants | 关 |
| Valid redirect URIs | `https://www.fuckanthropic.dev/`（本地调试再加 `http://localhost:8000/`）；同时写进 `OIDC_REDIRECT_URIS` |
| Web origins | 可以清空（浏览器不再用 fetch 调 Keycloak） |
| Advanced → Proof Key for Code Exchange Code Challenge Method | `S256` |
| Front channel logout | 关 |
| Backchannel logout URL | `https://api.luminet.cn/anthropic/v1/auth/backchannel-logout` |
| Backchannel logout session required | **开**（Logout Token 才带 `sid`，只注销对应会话） |
| 需要的 scope | `openid profile`（不再需要 `offline_access` / `email`） |

**管理员角色**（发布公告、强制下线）：

1. Clients → `app_vXmK3nB7cmKcW6q7` → Roles → Create role：`ip-please-admin`。
2. Users → 管理员账号 → Role mapping → Assign role → 选上面的客户端角色。
3. 可选：Clients → 客户端 → Client scopes → `…-dedicated` → Add mapper → By configuration →
   User Client Role：Client ID 选本客户端，Token Claim Name `ip_please_roles`，Multivalued 开，
   Add to ID token 开（其余关）。不配也行：后端还会读 Keycloak Access Token 默认带的
   `resource_access.<client>.roles`。
4. 角色在下次登录时写入会话；撤销角色后，在 Keycloak 里对该用户 Sign out（触发反向通道注销）即可立即生效。

**玩家名字与头像**（云同步面板、排行榜）：直接取 ID Token 的 claims，每次登录更新。

- 名字：`profile` scope 自带的 full name mapper 给出 `name`（名 + 姓）。没填姓名的账号依次退到
  `nickname`、`preferred_username`（含 `@` 的值跳过，不会把邮箱登上排行榜），都没有时显示「审查员」。
  想用别的 claim，改 `.env` 的 `OIDC_NAME_CLAIMS`。
- 头像：`profile` scope 自带的 `picture` mapper 读用户属性 `picture`（须是 https 图片地址）。
  Keycloak 24+ 的声明式 User profile 默认不收未登记的属性：Realm settings → User profile →
  Create attribute `picture`（或把 Unmanaged attributes 打开）。社交登录导入头像：Identity providers →
  对应 IdP → Mappers → Attribute Importer，把对方的头像 claim（GitHub 是 `avatar_url`）写进 `picture`。
  没有头像的玩家显示名字首字。
- 升级前已登录的玩家要重新登录一次，才会显示名字与头像（之前显示「审查员」）。
- 早期版本的自定义昵称表 `ip_please_profiles` 已不再使用，确认无误后可手动删除：
  `DROP TABLE ip_please_profiles;`

**切换顺序**（全体玩家需要重新登录一次）：

1. 部署新后端（`OIDC_CLIENT_SECRET` 先留空：公共客户端也能换码）。
2. 紧接着部署新前端（`index.html` 的 `?v=` 一并更新）。
3. Keycloak 打开 Client authentication、配置反向通道注销，把 secret 填进 `.env`，重新执行
   `deploy/install.sh`，再跑 `deploy/verify.sh`（会检查客户端已是机密客户端）。

自检反向通道：在 Keycloak 账号控制台（或 Admin → Sessions）注销一个已登录游戏的会话，
游戏下一次请求应提示「登录状态已失效」。后端日志会出现 `backchannel logout processed`。

## 5. 升级与回滚

```bash
cd /opt/ip-please-sync
docker compose pull
docker compose up -d
```

**从「前端直连 IdP」的旧版本升级**：新版本要求 `.env` 里有 `SESSION_JWT_SECRET`（和无尽模式用的
`ENDLESS_SEED_SECRET`），缺了容器会启动失败。直接重新执行 `bash deploy/install.sh`，它会补上这两个
密钥（已有值不覆盖），再按第 4 节调整 Keycloak。

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
- 会话：`ip_please_sessions` / `ip_please_refresh_tokens`（RT 只存 SHA-256）；后台任务每 5 分钟清理过期的
  登录尝试、RT 与结束超过 30 天的会话。
- 限流：单用户上传最小间隔 `SYNC_RATE_LIMIT_SECONDS`（默认 3 秒），登录 / 刷新按 IP（`X-Real-IP`）限流；
  都是内存实现，反向通道注销的 `jti` 防重放缓存也在内存里——只支持单副本，多副本部署时需换成
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
  - **1Panel 等面板托管 MySQL**：面板拉起的 MySQL 通常在 `1panel-network` 这个外部网络里，
    而本服务的 compose 在独立网络，默认解析不到 MySQL 容器名（典型报错 `pool timed out`）。
    把 [docker-compose.1panel.yml](docker-compose.1panel.yml) 复制为部署目录下的
    `docker-compose.override.yml` 后 `docker compose up -d`，连接串主机即可写 MySQL 容器名：
    ```env
    SYNC_DATABASE_URL=mysql://user:password@1Panel-mysql-xxxxx:3306/database
    ```
    确认 MySQL 容器实际网络：`docker inspect 1Panel-mysql-xxxxx --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`
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


## LINUX DO 小程序上线与验收

此节是待执行的运维/平台验收流程，不表示本分支已部署或已上传。App ID 固定为 `01a1baa6-abbf-7ed6-afac-bfa495a47dd3`。完整剧情、原作与 File Zero 致谢、网站存档/排行榜均保留。

### 配置与网络

- `.env` 设置 `MAPP_APP_ID=01a1baa6-abbf-7ed6-afac-bfa495a47dd3`；沿用现有数据库、`SESSION_JWT_SECRET`、`ENDLESS_SEED_SECRET`，不要更换每日种子密钥。
- Issuer 固定 `https://linux.do`，audience 固定 `https://api.luminet.cn`；允许后端访问 `https://linux.do/mini-app-api/jwks`。仅 ES256/P-256、SPKI SHA256 kid；禁止请求指定公钥地址，公钥缓存 1 小时、未知 kid 刷新冷却 5 秒，不跟随重定向。无自定义生产 JWKS 环境变量。
- 公网 HTTPS 暴露四个固定入口：`/anthropic/v1/mapp/bootstrap` GET、`profile` POST、`query` GET、`action` POST。代理完整保留查询字符串和 Authorization；不得在 access/error log 打印 Bearer JWT、请求体或用户凭据。无网站 cookie/会话回退。
- 应用 CORS 已固定允许 `https://linux.do`；代理也必须允许该 Origin（包含错误响应），GET/POST/OPTIONS、Authorization/Content-Type/Accept，并暴露 Retry-After。不要允许 `null` 来源或通配凭据。平台代理发出请求，游戏 iframe 无需直接连接 API。
- `sandbox|production` 来自已验签 JWT，不能靠客户端参数、header 或全局 `MAPP_CHANNEL` 切换。profile 的 string id 必须匹配 sub，名字只用于展示；不按用户名合并网站账号。平台没有网站 AT/RT 或管理权限。

```sh
curl -fsS https://api.luminet.cn/anthropic/v1/health
curl -i -X OPTIONS https://api.luminet.cn/anthropic/v1/mapp/action \
  -H 'Origin: https://linux.do' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
curl -i https://api.luminet.cn/anthropic/v1/mapp/bootstrap
# 未带 Bearer 的最后一个请求应为 401、application/json、private/no-store；不是登录验收。
```

### UTC+8 午夜规则切换与回滚

先完成本地/CI 验证、数据库备份和现有网站榜单/进行中 v1 对局基线记录，再单独批准生产部署。v2 的规则/生成输出会影响每日序列，必须在选定 **UTC+8 00:00 新一天开始后、当天尚未开放新版本每日挑战前** 完成后端与网站客户端配套切换；先协调暂停新挑战入口，避免同一天中途改序列。新的 `run_start` 必须带 `client_rules_version:2`，旧客户端开始新局收到 409 reload 提示。

只执行新增的 `006_mapp.sql` 幂等 CREATE TABLE 迁移；不得 DROP/TRUNCATE/ALTER 旧表、清榜、重置赛季或改旧对局的 `generator_version`。旧 v1 对局含旅客/波次/公告/通缉都按 v1 恢复；新 v2 才使用新生成逻辑。网站榜继续原历史；小程序正式/沙盒分榜由持久化 run source 决定，后台过期结算也不混榜。

发布后记录运行镜像 digest/源码 SHA、health、公共 CORS、真实网站新登录/旧局恢复/新 v2、平台沙盒流程。回滚需配套网站与后端，并保留新表和存档；不能直接把已有 v2 对局交给不识别 v2 的旧程序。出现问题先停新开局，保留数据库与证据，再选择兼容 v1/v2 的已验证镜像。不得以容器启动或 CI 成功替代这些验收。

### 可复现产物和实际平台上传

在本分支根目录、Node 22 中执行：

```sh
npm ci --prefix tests/frontend
node miniapp/build.mjs
npm test --prefix miniapp
(cd miniapp/dist/package && sha256sum -c SHA256SUMS)
unzip -l miniapp/dist/package/app.zip
```

ZIP 恰好包含 `manifest.json`、`index.html`、`app.js`、`app.css`、`strings.json`、`assets/{font,atlas,bg,win}.png`、`assets/LICENSE.txt`、`assets/OFL-fusion-pixel.txt`。不要上传 preview、Rust 测试服务、JWKS 私钥、浏览器脚本或测试数据库配置。官方 packer 的 SDK 0.3.0 固定提交和逐文件哈希在 `miniapp/vendor/provenance.json`；记录 ZIP SHA256、大小、版本与源码 SHA。

1. 在真实已登录的 LINUX DO 小程序开发者界面打开该 App ID，进入沙盒版本上传，选择上述 **app.zip**。检查平台展示的 ID、版本、权限和四个 endpoint；不要修改 manifest URL 去指向本地夹具。
2. 确认用户已授权 `user.read/user.lookup/network.request/storage.read/storage.write/theme.read/audio.webAudio/fullscreen/links.open`。保留网络响应状态、平台版本和脱敏截图，不记录 JWT/cookie。
3. 用真实平台账号启动，确认 bootstrap signed channel 为 sandbox、展示名自动同步、无网站登录/绑定码/管理入口；切换账号后旧镜像不可读，重开恢复新账号。
4. 简繁英日各检查字体、长文本、六 AI/表情、证件真实点击区域；桌面及手机触控拖证件、检查两字段、盖章/退证、测谎、全屏/音频/链接。
5. 完整剧情存档、历史快照、云端冲突的两个选择、失败后 Retry、关闭/重开恢复；中断已提交 action 的响应后重试，确认同 req_*、一次计分/一次存档版本。
6. 新 v2 无尽/每日：实际 inspect/decision、波次计时、结算与总榜/周榜/日榜、SDK 可见头像及失败首字回退；核对正式/沙盒/网站分榜与旧 v1/旧成绩保留。
7. 对照严格 CSP/Trusted Types 检查无运行时注入或控制台错误。记录每步通过/失败/未验证。只有沙盒流程通过且另获生产发布授权后，才进行正式版本提交/发布；本任务不执行生产发布。

没有可用的已认证平台界面时，上述步骤标为 **待验收**，不要获取用户浏览器 cookie 或把本地 fixture 成功写成平台成功。

### 网站静态资源原子发布与缓存验收

本次网站脚本统一使用 `?v=20261108-2`（包括 `game-host.js`），画面中的 `BUILD_VERSION` 为 `2026.11.08.2`。未来改动共享 JS 时必须一起更新全部脚本标记和 BUILD_VERSION；后端拒绝旧规则不是静态缓存失效的替代品。

1. 在新发布目录准备同一源码 SHA 的 `index.html` 与所有引用的 JS/素材，核对清单 SHA；完成部署授权后，以目录/版本切换方式一次发布。不能先切 HTML、再逐个覆盖旧目录里的 JS。保留上一完整版本供兼容回滚。
2. HTML 应强制再验证（例如 `Cache-Control: no-cache`）；CDN 必须把 query 参数纳入 JS 缓存键。若缓存层忽略 query，先修正规则或清除所有旧 JS 缓存。发布时清除/再验证 HTML，不能只刷新入口而保留相同 JS URL。
3. 以已经缓存旧站点的浏览器重新进入，Network 中核对每个本地脚本的 URL 都含同一新标记；检查响应内容/SHA 确实属于该发布目录。无痕冷启动再检查一次，确认没有新旧资源混搭，画面版本与 BUILD_VERSION 一致。
4. 运行 `node --test miniapp/tests/cache.test.cjs`、`node miniapp/build.mjs`，确认 index 解析器仍保留正确依赖顺序；修改产品源码后重新记录最终 ZIP 大小及 SHA256，使用该文件进行平台验收。

这些是待执行的发布/公共缓存验收步骤；本地测试通过不代表 CDN 已清除、平台已上传或生产已部署。
