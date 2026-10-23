# ip-please 项目协作规则

本文件是本仓库（游戏静态站 + `backend/` 云同步服务）的约定。新增代码必须遵守；与历史代码冲突时，
以本文件为准并顺带修正。

## 项目概览

本仓库是 [ip-please/ip-please.github.io](https://github.com/ip-please/ip-please.github.io) 的衍生版本：
游戏本体、剧本与素材来自原作，14 天剧情合并自茗（wess09）的 [ip-please-zero](https://github.com/wess09/ip-please-zero)
（《零号档案 · File Zero》），本版新增云存档同步、自有会话登录、公告与服务器权威的无尽模式排行榜
（`cloud.js` 等前端模块 + `backend/`）。登录面板与 README
必须保留对原作者与 mod 作者的致谢与来源说明，不得移除。
存档键沿用零号档案的 `STORAGE_KEYS`（`config.js`），`cloud.js` 的 `CFG.saveKey` 直接读它，不读原版的
`ip-please-save-v1`。云端可能留着改版前的旧存档（没有 `plot`），`cloud.js` 不会提示载入旧存档或已打出结局的存档。
日终同步挂在 `screens.js` 的 `summaryClick`，结局同步挂在 `plot.js` 的 `commitEnding`。

| 部分 | 位置 | 技术 |
| --- | --- | --- |
| 游戏前端 | 仓库根目录 `index.html` / `*.js` | 原生 JS + Canvas，无构建步骤 |
| 后端 | `backend/` | Rust（axum + sqlx + MySQL）：会话鉴权、云同步、公告、无尽模式 |
| 前端登录与云同步 | `cloud.js` | 原生 JS + fetch；登录换码由后端完成 |
| 部署产物 | `deploy/` | docker-compose + 反向代理说明 |
| 镜像流水线 | `.github/workflows/backend.yml` | GitHub Actions → GHCR |

## 后端 URL

- 云同步服务部署于 `https://api.luminet.cn/anthropic/`，**API BASE 为 `https://api.luminet.cn/anthropic/v1`**。
- 所有后端 API 路径必须以 `/anthropic/v1/` 开头；不得在该前缀之外新增后端 API 路由。
- 客户端请求、服务端路由定义和代理配置必须使用同一前缀，避免同一接口出现不同路径形式。
  - 客户端：`cloud.js` 中的 `CFG.apiBase`
  - 服务端：`backend/src/routes.rs` 的 `router()`
  - 代理：`deploy/README.md` 中的 nginx `location /anthropic/`

> 说明：通用模板要求使用 `/backend-api/*` 前缀。本项目按部署约定改为 `/anthropic/v1/*`（已确认），
> 这是本项目对该模板的唯一覆盖项，其余规范照旧执行。

## 标识符与 Prefix Registry

### 强制格式

- 业务层不得暴露无语义的纯数字递增 ID 或不带前缀的纯 UUID。业务层包括领域模型、应用服务、API DTO、
  URL 路由和参数，以及客户端状态和持久化状态。
- 项目生成或传递的对外标识符必须完整匹配以下格式；不得有空格、前后缀或换行：

  ```regexp
  ^[a-z]{2,8}_[0-9a-zA-Z]{16,32}$
  ```

- 前缀必须来自下方 Prefix Registry。前缀标明标识符所属的语义类型；后缀是不透明值，业务代码不得从中
  推导业务含义。
- 新增标识符类型前，先在 Prefix Registry 登记唯一前缀及其语义，再实现生成、解析和校验。不得自行临时
  拼接前缀，也不得复用或改变已登记前缀的含义。
- 数据库自增主键或内部 UUID 如因存储需要而保留，只能封装在持久化适配层内；进入领域模型、应用服务、
  API、URL 或客户端状态前，必须映射为符合本规范的标识符。不得把内部 ID 当作公开 ID 的别名。
- 在输入边界校验格式和类型前缀；拒绝纯数字、裸 UUID、未知前缀、格式错误或资源类型不匹配的值。
  序列化和构造 URL 时也必须校验，不能只依赖调用方。
- 生成后缀时使用足够安全的随机源或符合格式的标准唯一 ID 生成器；不得直接使用自增序号、时间戳或
  可预测的业务数据作为后缀。标识符一经分配应保持稳定，删除后不得复用。
- 标识符代表资源身份，不代表授权。每次访问仍须执行正常的身份验证和资源级权限检查。

实现位置：`backend/src/ids.rs`（`generate` / `is_valid` / `require`）。

### Prefix Registry

| 前缀 | 资源类型 | 用途 |
| --- | --- | --- |
| `user` | 用户 | `user_id`，由 IdP 的 `sub` 首次登录时映射生成并永久稳定 |
| `sess` | 会话 | `session_id`：OIDC 登录成功后由本服务签发，AT 的 `sid` claim 指向它 |
| `svc` | 服务主体 | 服务间授权 JWT 的调用方标识（保留） |
| `save` | 云存档快照 | `save_id`，每次日终上传生成一条不可变快照 |
| `ann` | 公告 | `announcement_id`，管理员发布的公告 |
| `run` | 无尽模式对局 | `run_id`，一局无尽 / 每日挑战 |
| `ent` | 无尽模式旅客 | `entrant_id`，对局中服务器下发的一位旅客 |
| `wave` | 无尽模式波次 | `wave_id`，对局中的黑话快剪 / 蒸馏大军波次 |

### 示例

```json
{
  "user_id": "user_01h455vb4pex5vbswgjp50gm20",
  "save_id": "save_9mQ2rT7xLpK4vN8wZbYc1d",
  "session_id": "sess_8Gf0a213e4b5d6e7KqZ1xW"
}
```

`refresh_token`、`login_verifier`、`state` 是凭据而非资源 ID；不得因此降低对秘密材料的保护
（RT 只在响应里出现一次，库里只存 SHA-256）。

## Backend API 响应与错误规范

实现位置：`backend/src/error.rs`（Rust）与 `cloud.js`（前端反查表）。

### 成功响应规范

1. **响应头与缓存控制**：所有返回 JSON 的接口设置 `Content-Type: application/json`；业务与鉴权接口
   设置 `Cache-Control: private, no-store`，健康检查设置 `Cache-Control: no-store`。
2. **标识符与字段约束**：响应体中的实体 ID 必须符合 Prefix Registry 格式。
   - 绝对过期时间戳用 Unix 秒戳（`expires_at`）；毫秒级同步/延迟用毫秒戳（`retry_after_ms`）。
   - 持久化业务日期用 ISO-8601 字符串（`updated_at`、`created_at`）。
   - 当前实现返回的 `updated_at` / `created_at` 均为 ISO-8601（UTC，毫秒精度）。
3. **错误响应双信封**：只允许以下两种结构。

#### 1. Detail 错误格式（`DetailErrorResponse`）

```json
{ "detail": "The password is incorrect." }
```

适用：`400 401（缺少 Token） 404 405 409 410 413 415 429 500 503`。

服务端必须通过 `detail_error_response(code)` / `detail_error_response_with_retry(code, secs)` 生成，
`code` 必须在 `DetailCode` 枚举登记。前端通过 `businessErrorCodeFromDetail(detail)` 反查。

| 错误码 | HTTP | 文案（对外契约，勿改） |
| --- | --- | --- |
| `not_found` | 404 | `The requested resource was not found.` |
| `invalid_request` | 400 | `The request is invalid.` |
| `method_not_allowed` | 405 | `Method not allowed.` |
| `sync_conflict` | 409 | `The cloud save has a newer version than the client base version.` |
| `sync_snapshot_expired` | 410 | `The requested save snapshot is no longer available.` |
| `sync_rate_limited` | 429 | `Too many sync requests. Please retry later.`（必须带 `Retry-After`） |
| `sync_unavailable` | 503 | `Cloud sync storage is temporarily unavailable.` |
| `backend_unavailable` | 503 | `The backend service is unavailable.` |
| `internal_error` | 500 | `Internal server error.` |
| `request_too_large` | 413 | `The request body is too large.` |
| `sync_payload_too_large` | 413 | `The save payload exceeds the size limit.` |
| `unauthorized` | 401 | `Unauthorized`（缺少 `Authorization` 头） |
| `login_attempt_invalid` | 400 | `The login attempt is invalid or has expired.` |
| `rate_limited` | 429 | `Too many requests. Please retry later.`（必须带 `Retry-After`） |
| `nickname_invalid` | 400 | `The nickname is not allowed.` |
| `endless_run_active` | 409 | `An endless run is already in progress.` |
| `endless_state_conflict` | 409 | `The endless run state has changed. Please reload.` |
| `daily_already_played` | 409 | `Today's daily challenge has already been played.` |

#### 2. Auth 错误格式（`AuthErrorResponse`）

```json
{
  "error": {
    "message": "Invalid or expired authentication token",
    "type": null,
    "code": "invalid_token",
    "param": null
  },
  "status": 401
}
```

| code | HTTP | 场景 |
| --- | --- | --- |
| `invalid_token` | 401 | AT 格式错误、签名不合法、过期或非本服务签发；RT 在 10 秒宽限期内被重放 |
| `token_revoked` | 401 | 会话已吊销 / 过期（登出、RT 泄露重放、IdP 反向通道注销、管理员强制下线） |
| `insufficient_scope` | 403 | 会话有效但缺少权限（例如非管理员调用 `/admin/*`） |
| `session_validation_failed` | 503 | 会话库查询失败、IdP discovery / JWKS / Token 端点不可达 |

必须通过 `auth_error_response(status, code, message)` / `authorization_failure_response(code)` 生成，
`status` 字段必须与 HTTP 状态码一致。

### 状态码与响应头配合

| 场景 | HTTP | 响应格式 | 附加要求 |
| --- | --- | --- | --- |
| 缺少 Authorization 头 | 401 | `{ "detail": "Unauthorized" }` | 前端提示登录 |
| Token 无效 / 过期 | 401 | `AuthErrorResponse` (`invalid_token`) | 前端用 RT 刷新并重试一次 |
| 会话失效 / 吊销 | 401 | `AuthErrorResponse` (`token_revoked`) | 前端清理凭据并登出 |
| 权限 / Scope 不足 | 403 | `AuthErrorResponse` (`insufficient_scope`) | 禁止无意义重试 |
| 资源未找到 / 路径非法 | 404 | `DetailErrorResponse` (`not_found`) | - |
| 请求体 / 查询参数解析失败 | 400 | `DetailErrorResponse` (`invalid_request`) | 一律经 `backend/src/extract.rs` |
| 版本冲突 | 409 | `DetailErrorResponse` (`sync_conflict`) | 前端拉取云端并让玩家选择 |
| 请求体过大 | 413 | `DetailErrorResponse` (`request_too_large` / `sync_payload_too_large`) | - |
| 请求频次限制 | 429 | `DetailErrorResponse` (`sync_rate_limited` / `rate_limited`) | 必须带 `Retry-After` |
| 依赖故障 | 503 | `DetailErrorResponse` (`sync_unavailable` / `backend_unavailable`) | - |

## 云同步协议

- `GET /anthropic/v1/health` → `{"status":"ok","db":"ok"}`（`no-store`）
- `GET /anthropic/v1/sync/save` → 当前云存档；无存档返回 404 `not_found`
- `POST /anthropic/v1/sync/save` → `{ "day": 2, "payload": {...}, "base_version": 1 }`
  - `payload` 为游戏存档 `S` 的完整 JSON 快照
  - 服务端 `version` 单调递增；`base_version` 与云端当前版本不一致时返回 409 `sync_conflict`
  - 成功后返回 `{ user_id, save_id, version, day, updated_at }`
- `GET /anthropic/v1/sync/snapshots?limit=50` → 快照列表（倒序）
- `GET /anthropic/v1/sync/snapshots/{save_id}` → 单条快照；`save_id` 不合法或不存在返回 404/410

冲突策略：单存档槽 + 每日快照；冲突由前端弹窗让玩家选择「用云端」或「保留本机」，
不允许静默覆盖。

## 鉴权协议（会话 `sess_*`）

浏览器只跳转 IdP 授权页，**不直接调用 IdP 的 Token 端点**。换码、校验 ID Token、签发凭据都在后端完成；
IdP 的 Token 用完即弃，对外只发本服务自己的 AT / RT。

1. `POST /anthropic/v1/auth/login` `{ "login_challenge": "<b64url(SHA256(login_verifier))>", "redirect_uri"? }`
   → `{ authorize_url, state, expires_at }`。后端在 `ip_please_login_attempts` 里保存 state 摘要、nonce、
   PKCE verifier（10 分钟有效、单次使用）。`redirect_uri` 必须在 `OIDC_REDIRECT_URIS` 里。
2. 前端核对 `authorize_url` 的源是 IdP（`https://auth.luminet.cn`），把 `{state, login_verifier}` 存进
   `sessionStorage`（键 `ip-please-login-v2`）后跳转。
3. IdP 回跳游戏页面，前端清理 URL、核对 state，`POST /auth/callback`
   `{ code, state, login_verifier, iss }` → TokenResponse。后端要求浏览器出示 verifier 原文：
   只拿到 `code + state` 的人兑换不了。
4. `POST /auth/refresh` `{ refresh_token }` → TokenResponse（每次换新 RT）。
   旧 RT 10 秒内重放 → 401 `invalid_token`（多标签页竞态，前端重读存储）；超过 10 秒重放视为泄露，
   吊销整个会话 → 401 `token_revoked`。未知 / 过期 / 已吊销 → 401 `token_revoked`。
5. `POST /auth/logout` `{ refresh_token, all_sessions? }` → `{ "status": "ok" }`（未知 RT 也返回成功）。
6. `POST /auth/backchannel-logout`（IdP 服务器调用，form `logout_token=<JWT>`）：按 OIDC Back-Channel
   Logout 1.0 校验 RS256 签名、`iss`、`aud`、`iat`（600 秒内）、`events` 含
   `http://schemas.openid.net/event/backchannel-logout`、无 `nonce`、至少有 `sid` / `sub`、`jti` 防重放。
   有 `sid` 只吊销对应 IdP 会话的本地会话；只有 `sub` 时吊销该用户全部会话。成功 200，校验失败 400。
7. `GET /me` → `{ user_id, nickname, nickname_set, tag, is_admin, session }`；`POST /me/profile`
   `{ nickname }`（2–16 字，字母数字与 ` _-·.`，禁止网址与「官方」「管理」「客服」「admin」字样）。
8. `POST /admin/sessions/revoke` `{ user_id }` → `{ revoked }`（仅管理员）。

TokenResponse：

```json
{
  "token_type": "Bearer", "access_token": "<HS256 JWT>", "expires_in": 600, "expires_at": 1761234567,
  "refresh_token": "<43 位 b64url>", "refresh_expires_at": 1762444167,
  "session_id": "sess_…", "session_expires_at": 1763826567,
  "user": { "user_id": "user_…", "nickname": "审查员-7F3K", "nickname_set": false, "tag": "A1B2", "is_admin": false }
}
```

- AT：HS256，claims `{iss: TOKEN_ISSUER, aud: "ip-please", sub: user_id, sid: session_id, iat, exp}`，
  只接受 HS256（拒绝 `none` / RS256 等算法混淆），按 `kid` 支持 `SESSION_JWT_SECRET_PREVIOUS` 轮换。
  **每次请求查会话表**：吊销立即生效。
- 会话：闲置上限 `SESSION_IDLE_DAYS`（每次刷新顺延）+ 绝对上限 `SESSION_MAX_DAYS`。
- 管理员：Keycloak 客户端角色 `OIDC_ADMIN_ROLE`（默认 `ip-please-admin`），登录时从 ID Token 的
  `OIDC_ROLES_CLAIM` 或 IdP Access Token 的 `resource_access.<client>.roles` 读取并写入会话；
  撤销角色在下次登录（或 IdP 注销触发反向通道）后生效。
- 排行榜与面板只显示昵称 + 4 位标签（`sha256(user_id)` 前缀），永不显示 IdP 用户名或邮箱。

## 公告协议（`ann_*`）

- `GET /anthropic/v1/announcements`（无需登录，按 IP 限流）→ `{ "announcements": [ { announcement_id, title,
  body, level, starts_at, ends_at|null, created_at } ] }`：只含已开始、未结束、未下线的，最新在前，最多 10 条。
- 管理员（会话 `is_admin`，否则 403 `insufficient_scope`）：
  - `GET /admin/announcements?include_retired=1` → 同上，另含 `retired_at`、`created_by`；
  - `POST /admin/announcements` `{ title ≤60 字, body ≤500 字, level: info|warning|maintenance, starts_at?, ends_at? }`
    → 201；时间为 ISO-8601，`ends_at` 必须晚于开始与当前时间；
  - `POST /admin/announcements/{announcement_id}/retire` → 200（重复下线幂等）。
- 前端 `announce.js`：左上角横幅显示最新一条未关掉的公告，关掉的 ID 存 `localStorage`
  （`ip-please-announce-dismissed-v1`，只保留仍生效的）；页面可见时每 15 分钟刷新。
  公告与昵称**只用 DOM 的 `textContent` 显示**：canvas 像素字库没有任意文字的字形，也避免 XSS。
- 管理员区块挂在云同步面板里（`CloudSync.addPanelSection`），权限以后端为准。

## 无尽模式协议（服务器权威，`run_*` / `ent_*` / `wave_*`）

服务器生成旅客、判定、计分；前端只拿到「证件上写了什么」（`PublicEntrant`：证件字段、开场白原文、登录记录、
X 光物品），**正确答案、破绽、谁会接测谎题都不下发**。实现：`backend/src/endless/`，前端 `endless.js`。

- 生成：第 `t` 位旅客只由 `(种子, t)` 决定（ChaCha20 + HMAC 子流，自写抽样函数）。改生成逻辑必须提升
  `GENERATOR_VERSION` 并更新 golden hash，且只在 UTC+8 午夜后上线（否则当天每日挑战的序列会变）。
  每第 9 格是波次（黑话快剪 / 蒸馏大军交替）。
- 会显示给玩家的字符串（开场白、地名、黑话）必须与前端 JS 原文一致：`tables.rs` 的测试会读 `data.js` /
  `endless.js` / `assets.js` 核对；破绽说明、追问、反应、罚单文案只在前端（按 `kind` 取）。
- 接口（全部需要会话，按用户限流）：
  - `POST /endless/runs {mode: endless|daily}` → 201 `{run, item:null}`；已有进行中对局 409 `endless_run_active`，
    今天的每日挑战已玩过 409 `daily_already_played`。
  - `GET /endless/runs/current` → `{run, item}`（刷新页面后接着玩；闲置 / 超时的对局会被结算，返回 404）。
  - `GET /endless/runs/{run_id}` → `{run, final}`（本人或管理员）。
  - `POST …/next` → `{run, item}`：待处理项目未处理时重复返回同一个。
  - `POST …/inspect {entrant_id, fields:[a,b] | say:i}` → `{match, issue?, new, claims_left, locked}`：
    两个字段顺序无关；单字段只接受 `xr.*`；每位旅客错 6 次锁定。
  - `POST …/quiz {entrant_id}` → `{exposed}`：先指认出破绽才能测谎（否则 400），结果缓存。
  - `POST …/decision {entrant_id, decision}` → `{correct, points, breakdown, reveal, citation, run, final}`：
    距离发放不足 1.8 秒返回 429；同一请求重发返回同一结果，换判定 409。
  - `POST …/waves/{wave_id}/result`：快剪 `{picks:[{i, pick, rt_ms}]}`，蒸馏大军 `{hits:[{i, t_ms}]}`；
    服务器按波次时长、反应时间、冲关者窗口校验，太早提交 429，不合理的时序记一次违规。
  - `POST …/abandon` → `{run, final}`。
  - `GET /endless/daily`（可不登录）→ `{date, played, in_progress, run_id, travelers:40, resets_at}`。
  - `GET /endless/leaderboard?board=endless|weekly|daily&period=&limit=`（可不登录）→
    `{board, period, entries:[{rank, nickname, tag, score, travelers, best_streak, achieved_at, me}], me}`。
- 计分（`scoring.rs`，只增不减）：判对 100；拒绝 / 拘留有破绽的旅客时既没指认也没测谎揭穿 = 猜，只有 60；
  盖章前指认出真实破绽 +50（第一次指认成功前错超过 3 次不算）；拘留被测谎揭穿的说谎者 +50；连对倍率
  ×1 / ×1.5（5+）/ ×2（10+）/ ×3（20+）；拘留通缉犯 +500（不乘倍率）；快剪每张 20、全对 +60；蒸馏大军每个 15、
  全中 +50；判错 0 分、连对清零、警告 +1，3 次结束。
- 新玩法：每日挑战（日期 + `ENDLESS_SEED_SECRET` 定种子，全服同一批 40 位，每人每天一次）；
  突发规则（第 10–14 位起每段 5 位，临时禁令 device / country / state，违者按有破绽判，可点 `bul.规则` 指认）；
  通缉令（每 40 位一张，通缉犯用化名混进来，只有脸对得上，可点 `face` / `pp.photo` + `wt.photo` 指认）。
- 防作弊：每人同时一局（`active_user_id` 唯一键）、每日一次（`(user_id, daily_date)` 唯一键）、所有变更在
  `SELECT … FOR UPDATE` 事务里并写操作日志、时间以服务器为准；时序违规 3 次的对局不上榜。闲置 15 分钟、
  无尽 4 小时 / 每日 1 小时自动结算。读证件内容的机器人无法根绝：目标是答案不下发、分数只由服务器计算。
- 排行榜：总榜 `endless/all`、周榜 `weekly/2026-W43`（UTC+8 ISO 周）、日榜 `daily/2026-10-24`，个人最高分。

## 前端鉴权约定

- 登录态存 `localStorage`（键 `ip-please-auth-v2`）：`{access_token, refresh_token, expires_at(毫秒),
  session_id, user}`。发现旧键 `ip-please-auth-v1`（前端直连 IdP 时代）时删除并提示重新登录一次。
- AT 提前 60 秒刷新；401 `invalid_token` 刷新后重试一次；401 `token_revoked` 清理凭据并登出。
- 刷新用 `navigator.locks`（`ip-please-auth-refresh`）在多标签页间串行化，并监听 `storage` 事件同步
  其他标签页的换新与登出。
- 回调地址：`https://www.fuckanthropic.dev/`（同页回调），必须同时登记在 Keycloak 的
  Valid redirect URI 与后端 `OIDC_REDIRECT_URIS` 中。
- 前端只与 IdP 授权页（跳转）和 `api.luminet.cn` 通信，不经过第三方。

## 目录结构

```
index.html / *.js          游戏本体（无构建）
cloud.js                   登录与云同步前端模块（也提供 api / 面板扩展给其他模块）
announce.js                公告横幅与管理员区块
endless.js                 无尽模式前端：服务器数据 → 证件对象、指认 / 判定 / 波次接口、大厅与排行榜
backend/                   Rust 后端（lib + bin）
  src/lib.rs               AppState、build_app、client_ip
  src/main.rs              启动
  src/{config,error,ids,db,util,extract,ratelimit,maintenance,profile,routes}.rs
  src/auth/{mod,jwks,oidc,tokens,session,routes}.rs
  src/endless/{rng,tables,model,generator,scoring,state,store,routes}.rs
  migrations/00N_*.sql     每次启动按顺序执行（只建新表，不 ALTER）
  tests/{router,integration}.rs、tests/fixtures/（仅测试用 RSA 密钥）
  Dockerfile
tests/frontend/            cloud.js 的 jsdom 集成测试（不参与线上部署）
deploy/                    docker-compose、install.sh、verify.sh 与部署说明
.github/workflows/         backend.yml（fmt/clippy/test + GHCR）、frontend.yml
AGENT.md                   本文件
```

## 测试与 CI

| 范围 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 后端单元 + 路由测试 | `cd backend && cargo test --locked` | 错误码、ID 格式、AT 签发校验 / 算法混淆、RT 轮换判定、ID Token 与 Logout Token 校验、限流、不连库路径的双信封 |
| 无尽模式前端 | `node tools/endless_client_test.js` | 服务器证件组装、无答案、破绽文案覆盖、指认 / 测谎 / 判定 / 波次、恢复、冲突重同步 |
| 剧情回归 | `node tools/plot_regression_test.js`、`node tools/smoke_test.js` | 14 天剧情与 30 个结局不受影响 |
| 后端集成测试 | `docker run -d -p 127.0.0.1:33306:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=ip_please_test mysql:8.0`，然后 `TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33306/ip_please_test cargo test --locked -- --ignored` | 迁移幂等、完整登录（模拟 IdP 校验 PKCE 与 client secret）、RT 轮换与重放吊销、反向通道注销、管理员与昵称、公告、无尽模式完整对局 / 排行榜 / 每日挑战 / API 指认 |
| 前端集成 | `cd tests/frontend && npm ci && npm test` | jsdom 加载真实 `cloud.js` / `announce.js`：发起登录、回调换会话、旧登录态清理、日终上传、冲突弹窗、刷新 / 并发刷新 / 吊销登出、昵称；公告横幅、关闭记忆、XSS、管理员发布 / 下线 |
| 线上验收 | `bash deploy/verify.sh` | health、401 双信封、CORS 预检、`/auth/*` 契约、Keycloak 机密客户端 |

CI 要求（main 分支必须保持绿）：
- `backend.yml`：`cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`，
  MySQL 服务容器上的 `cargo test --locked -- --ignored`，随后多架构构建推送 GHCR。
- `frontend.yml`：`npm ci`、所有根目录 JS 的 `node --check`、jsdom 测试、`tools/endless_client_test.js`、
  剧情回归（`plot_regression_test.js`、`smoke_test.js`、`storage_namespace_test.js`）。
- 改了画布上显示的中文：同步 `en.js` / `ja.js`（`node tools/check_i18n.js` 检查），`python tools/gen_zh_hant.py`
  重新生成繁体，`python tools/build_assets.py` 重建像素字库（`tools/requirements.txt`）。

## 环境变量（backend）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SYNC_DATABASE_URL` | 是 | `mysql://user:pass@host:3306/db`，复用服务器现有数据库 |
| `SESSION_JWT_SECRET` | 是 | AT 签名密钥，至少 32 字节（`openssl rand -hex 32`） |
| `SESSION_JWT_SECRET_PREVIOUS` | 否 | 轮换期间仍接受的上一把密钥 |
| `ENDLESS_SEED_SECRET` | 是 | 每日挑战种子密钥，至少 32 字节；上线后不要更换 |
| `OIDC_ISSUER` | 否 | 默认 `https://auth.luminet.cn/realms/prod` |
| `OIDC_CLIENT_ID` | 否 | 默认 `app_vXmK3nB7cmKcW6q7` |
| `OIDC_CLIENT_SECRET` | 否 | 机密客户端 secret；留空时按公共客户端换码（切换期兼容） |
| `OIDC_REDIRECT_URIS` | 否 | 逗号分隔，默认 `https://www.fuckanthropic.dev/` |
| `OIDC_SCOPE` | 否 | 默认 `openid profile` |
| `OIDC_ROLES_CLAIM` | 否 | ID Token 里的角色 claim，默认 `ip_please_roles` |
| `OIDC_ADMIN_ROLE` | 否 | 管理员角色，默认 `ip-please-admin` |
| `OIDC_JWKS_URL` | 否 | 覆盖 discovery 里的 jwks_uri，测试用 |
| `TOKEN_ISSUER` | 否 | AT 的 `iss`，默认 `https://api.luminet.cn/anthropic` |
| `ACCESS_TOKEN_TTL_SECONDS` | 否 | 默认 600 |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | 否 | 默认 14 / 30 |
| `CLIENT_IP_HEADER` | 否 | 反向代理写入真实 IP 的头，默认 `x-real-ip`（限流用） |
| `ALLOWED_ORIGINS` | 否 | 逗号分隔的 CORS 白名单 |
| `SYNC_MAX_PAYLOAD_BYTES` | 否 | 默认 262144 |
| `SYNC_RATE_LIMIT_SECONDS` | 否 | 默认 3，单用户上传最小间隔 |
| `BIND_ADDR` | 否 | 默认 `0.0.0.0:8080` |

## 未采用模板项

- 模板中的 Next.js 规则块不适用：本仓库没有 Next.js，前端是原生 JS 静态站。
- 模板要求的 `/backend-api/*` 前缀被本项目的 `/anthropic/v1/*` 取代（见「后端 URL」）。
