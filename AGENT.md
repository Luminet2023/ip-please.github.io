# ip-please 项目协作规则

本文件是本仓库（游戏静态站 + `backend/` 云同步服务）的约定。新增代码必须遵守；与历史代码冲突时，
以本文件为准并顺带修正。

## 项目概览

本仓库是 [ip-please/ip-please.github.io](https://github.com/ip-please/ip-please.github.io) 的衍生版本：
游戏本体、剧本与素材来自原作，14 天剧情合并自茗（wess09）的 [ip-please-zero](https://github.com/wess09/ip-please-zero)
（《零号档案 · File Zero》），本版只新增云存档同步（`cloud.js` + `backend/`）。登录面板与 README
必须保留对原作者与 mod 作者的致谢与来源说明，不得移除。
存档键沿用零号档案的 `STORAGE_KEYS`（`config.js`），`cloud.js` 的 `CFG.saveKey` 直接读它，不读原版的
`ip-please-save-v1`。云端可能留着改版前的旧存档（没有 `plot`），`cloud.js` 不会提示载入旧存档或已打出结局的存档。
日终同步挂在 `screens.js` 的 `summaryClick`，结局同步挂在 `plot.js` 的 `commitEnding`。

| 部分 | 位置 | 技术 |
| --- | --- | --- |
| 游戏前端 | 仓库根目录 `index.html` / `*.js` | 原生 JS + Canvas，无构建步骤 |
| 云同步后端 | `backend/` | Rust（axum + sqlx + MySQL） |
| 前端云同步 | `cloud.js` | 原生 JS，OIDC PKCE + fetch |
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
| `sess` | 会话 | 会话标识符，例如 `current_session_id`（本服务暂未签发会话 ID，保留） |
| `svc` | 服务主体 | 服务间授权 JWT 的调用方标识（保留） |
| `save` | 云存档快照 | `save_id`，每次日终上传生成一条不可变快照 |

### 示例

```json
{
  "user_id": "user_01h455vb4pex5vbswgjp50gm20",
  "save_id": "save_9mQ2rT7xLpK4vN8wZbYc1d",
  "current_session_id": "sess_89f0a213e4b5d6e7"
}
```

`refresh_token` 是凭据而非资源 ID；不得因此降低对秘密材料的保护。

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
| `invalid_token` | 401 | Token 缺失后格式错误、签名不合法、过期或非本客户端签发 |
| `token_revoked` | 401 | 会话已吊销（当前由 IdP 刷新失败触发前端本地登出） |
| `insufficient_scope` | 403 | Token 校验通过但缺少接口所需 scope |
| `session_validation_failed` | 503 | JWKS 拉取失败等会话校验依赖故障 |

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
| 版本冲突 | 409 | `DetailErrorResponse` (`sync_conflict`) | 前端拉取云端并让玩家选择 |
| 请求体过大 | 413 | `DetailErrorResponse` (`request_too_large` / `sync_payload_too_large`) | - |
| 请求频次限制 | 429 | `DetailErrorResponse` (`sync_rate_limited`) | 必须带 `Retry-After` |
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

## 前端鉴权约定

- 公共客户端 + Authorization Code + PKCE，`code_challenge_method = S256`；不保存 client_secret。
- Access Token 有效期 600 秒（`expires_in`），前端提前 60 秒刷新；遇到 401 `invalid_token` 强制刷新
  并重试一次请求。
- 刷新令牌保存在 `localStorage`（键 `ip-please-auth-v1`），登出时清除。
- 刷新请求：`POST {issuer}/protocol/openid-connect/token`，`grant_type=refresh_token`。
- 回调地址：`https://www.fuckanthropic.dev/`（同页回调），必须与 Keycloak 中登记的
  Valid redirect URI 完全一致。
- 前端只与 IdP 与 `api.luminet.cn` 通信，不经过第三方。

## 目录结构

```
index.html / *.js          游戏本体（无构建）
cloud.js                   云同步前端模块
backend/                   Rust 云同步服务
  src/{main,config,error,ids,auth,db,routes}.rs
  migrations/001_init.sql
  Dockerfile
tests/frontend/            cloud.js 的 jsdom 集成测试（不参与线上部署）
deploy/                    docker-compose、install.sh、verify.sh 与部署说明
.github/workflows/         backend.yml（fmt/clippy/test + GHCR）、frontend.yml
AGENT.md                   本文件
```

## 测试与 CI

| 范围 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 后端单元测试 | `cd backend && cargo test --locked` | 错误码状态映射、标识符格式校验 |
| 后端本地端到端 | 起 MySQL 容器 + 本地 mock OIDC 后跑冒烟脚本 | JWT 校验、双信封、409/429/413、CORS、用户隔离 |
| 前端集成 | `cd tests/frontend && npm ci && npm test` | jsdom 加载真实 `cloud.js`：PKCE、回调换 token、日终上传、冲突弹窗、401 刷新、吊销登出 |
| 线上验收 | `bash deploy/verify.sh` | health、401 双信封、CORS 预检、Keycloak 回调与 Web Origins |

CI 要求（main 分支必须保持绿）：
- `backend.yml`：`cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`，随后多架构构建推送 GHCR。
- `frontend.yml`：`npm ci`、`node --check cloud.js`、jsdom 测试。

## 环境变量（backend）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SYNC_DATABASE_URL` | 是 | `mysql://user:pass@host:3306/db`，复用服务器现有数据库 |
| `OIDC_ISSUER` | 否 | 默认 `https://auth.luminet.cn/realms/prod` |
| `OIDC_CLIENT_ID` | 否 | 默认 `app_vXmK3nB7cmKcW6q7` |
| `OIDC_JWKS_URL` | 否 | 覆盖 discovery，测试用 |
| `OIDC_REQUIRED_SCOPE` | 否 | 默认 `openid`；置空则不做 scope 校验 |
| `ALLOWED_ORIGINS` | 否 | 逗号分隔的 CORS 白名单 |
| `SYNC_MAX_PAYLOAD_BYTES` | 否 | 默认 262144 |
| `SYNC_RATE_LIMIT_SECONDS` | 否 | 默认 3，单用户上传最小间隔 |
| `BIND_ADDR` | 否 | 默认 `0.0.0.0:8080` |

## 未采用模板项

- 模板中的 Next.js 规则块不适用：本仓库没有 Next.js，前端是原生 JS 静态站。
- 模板要求的 `/backend-api/*` 前缀被本项目的 `/anthropic/v1/*` 取代（见「后端 URL」）。
