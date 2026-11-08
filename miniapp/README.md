# LINUX DO edition

The full File Zero story (14 days, 30 endings), cloud saves and history, endless and daily modes share the website's original game sources. Website storage keys, identity and boards remain independent. No production publishing is performed by these scripts.

Use Node 22. No bundler, Bun, runtime code loading or install step is needed for the production build:

```sh
node miniapp/build.mjs
node --test miniapp/tests/host.test.cjs miniapp/tests/dom.test.cjs miniapp/tests/package.test.cjs
node miniapp/tests/browser.cjs
node miniapp/preview/server.mjs
```

The DOM/package tests use `tests/frontend/node_modules/jsdom` (run `npm ci` there first). Browser tests use Playwright Core and installed Chromium; set `PLAYWRIGHT_CORE` to its absolute module path if the documented workstation default is unavailable. `BROWSER_ARTIFACTS` controls screenshots (default `/tmp/ip-please-task3-browser`).

`dist/package/app.zip`, `manifest.json`, `package.json` (official metadata), and `SHA256SUMS` are generated. Upload only the ZIP when platform acceptance is authorized. The pinned official 0.3.0 packer enforces a 32 MiB ZIP / 128 MiB expanded / 32 MiB individual-file / 1024-file bound. The build verifies every vendored SDK byte against `vendor/provenance.json` before using it. The bundled SDK accessor reads the real loader's SDK. Source: [official guide at pinned commit](https://github.com/linux-do/mapp-developer-guide/tree/0b2a037e3b18d1ebd97bb2e3b734eb97ab0358fc). Original game and font license texts are declared package assets.

The build extracts the four embedded PNGs without re-encoding them and retains sprite/font metadata. It compiles the existing dependency order into one IIFE, strips website shell scripts/inline attributes from the package fragment, and binds controls to SDK capabilities. The website still loads individual scripts without a build.

`game-host.js` provides an account-scoped synchronous storage mirror over the asynchronous SDK store. The namespace uses the backend's stable `user_*`, itself scoped by verified issuer/app/sub, with a channel-neutral `:v2:shared:` record prefix. The SDK itself isolates channel storage; the app cannot override that platform boundary. Only legacy records present in the current SDK export are read for migration, and are never rewritten. Credentials and avatar URLs are never persisted. Day/ending transitions wait for all dirty revisions. Failed persistence keeps the transition callback and dirty memory available to Retry.

Actions write a durable journal before transport. Timeout, offline, 401, 429 and 5xx preserve the original `req_*`, operation and args; SDK 401 reauthorization retries the same envelope. A known terminal response acknowledges the journal; a failed acknowledgement write retains its in-memory request. New, different actions wait until existing unknown actions are recovered. Save acknowledgements update the cloud base version together with the journal. Reopening shows Retry for unresolved actions. Conflicts retain the existing explicit cloud/local choice; stale run retries use current/run queries.

The only network declarations are the four fixed platform-authenticated `/anthropic/v1/mapp/` endpoints. `bootstrap.channel` is returned from the verified server principal as a diagnostic session label; saves, daily quotas, runs, receipts and all leaderboards share server data across sandbox and production; neither launch arguments nor client state chooses the backend channel. Profile fields are presentation only. Avatar lookup accepts only exact decimal safe integers, starts when visible, coalesces per session, uses SDK Blob URLs, and falls back to initials.

`preview/` is deliberately outside the ZIP. It serves the exact built app in an opaque-origin `sandbox="allow-scripts"` iframe with `connect-src 'none'`, `require-trusted-types-for 'script'`, and `trusted-types 'none'`. Its deterministic SDK/server fixture runs in the parent; the app frame can access assets/storage/network only through the fixture bridge. Browser tests use real canvas pointer/touch inputs and PNG rendering. Fixture decision responses prove client transport/UI handling, not real authentication or authoritative server scoring. Signed backend/MySQL tests provide separate server evidence. Actual LINUX DO sandbox upload, real SDK session policies and live backend acceptance remain external acceptance steps.

## Stronger local acceptance

```sh
npm ci --prefix tests/frontend
npm install --no-save --package-lock=false playwright-core@1.59.1
npx playwright-core install chromium
export PLAYWRIGHT_CORE="$PWD/node_modules/playwright-core"
export BROWSER_ARTIFACTS=/tmp/ip-please-miniapp-acceptance
node miniapp/build.mjs
npm test --prefix miniapp
node miniapp/tests/browser.cjs
# Dedicated disposable MySQL only; use your local fixture credentials, never production.
TEST_DATABASE_URL='mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:33306/ip_please_test' node miniapp/tests/backend-browser.cjs
TEST_DATABASE_URL='mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:33306/ip_please_test' node miniapp/tests/guest-browser.cjs --backend
node miniapp/tests/visual.cjs
```

The backend browser script starts the **real Rust router and MySQL store** via a test-only example. A loopback parent bridge signs requests using the repository's public test ES256 key and serves its JWKS; signatures, query binding, transactions, receipts, scoring and board queries execute in Rust. Game timing checks remain enabled; request burst throttling is disabled in this fixture. No Authorization header/token enters screenshots or call reports. The bridge and keys remain outside the ZIP and production binary. This is stronger local integration evidence, still not a real LINUX DO account/session, platform permission, public proxy or production deployment test.

The separate visual scene audit uses actual shared-source Canvas PNG rendering for all six new AI (plus existing cast), eight expressions, four languages, long translated documents and actual `fieldAt` targets. Its fixture scene setup is explicitly separate from built-IIFE real mouse/touch play; it does not claim a natural 14-day browser playthrough. The deterministic story suite covers all 14 days and 30 endings.

Storage concurrency uses the pinned SDK `localStorage.exportData()` snapshot (`{format:1, entries:[[key,value],...]}`) and transactional `importData()` **merge**, under the existing `storage.read/write` permissions. Each account has independent dirty-key records; removal writes a tombstone. The original account blob is a read-only migration base. A preference-only flush cannot rewrite a save. Two intentional writes to the same ordinary key use last completed write semantics, matching the single local save slot. Open mirrors refresh during flush/recovery; another window's changes are not pushed into a running game.

Ending IDs are unioned via separate records. Each original `req_*` envelope has its own record; acknowledgements use separate keys and always dominate late journal writes. A save acknowledgement contains its version metadata atomically; hydration takes the highest acknowledged version, so an older delayed response cannot roll it back. Save conflicts remain pending until explicit cloud/local choice; local choice atomically journals the replacement request and acknowledges the rejected one. No Web Locks, origin assumptions, advisory lock or second-window restriction is used. Acknowledgement/history keys are retained to prevent delayed writers resurrecting operations; storage use therefore grows with actions. Failed quota/storage operations retain dirty state and show Retry. Cross-device synchronization remains the cloud protocol, not SDK storage.

Release website HTML and all referenced local JS as one immutable release. The current cache tag `20261109-2` matches `BUILD_VERSION=2026.11.09.2`; every script, including `game-host.js`, carries it. After the final source edit rebuild the ZIP and record its new `SHA256SUMS`, then follow the atomic publication/cache checks in `deploy/README.md`.

Guests boot with SDK `user.getCurrent() === null` without bootstrap, profile, HTTP/JWT, user lookup or website credentials. The complete 14-day story and all 30 endings remain available through an anonymous SDK local-storage mirror. Day and ending transitions use the same durable flush/retry barrier as signed-in play. Endless and daily modes require platform sign-in. The login action explains how to sign in on the parent LINUX DO platform, without an OIDC redirect.

On return to the visible app, identity checking flushes guest dirty writes before automatically reloading into the verified account. The guest copy, account transfer marker and one-time guest claim are committed together by SDK `importData()`; the original guest data stays intact. An existing different account-local save requires an explicit choice before changing it. The first promoted save uploads immediately with base version zero; existing cloud data returns a normal 409 and requires the cloud/local choice. Creating that upload atomically consumes the transfer marker with the original request journal, so a lost reply reopens the original `req_*` rather than creating another promotion. The claim records the guest content revision and its owning account. The same account can import a later guest revision; unchanged guest history is not imported repeatedly. A claimed guest archive is not imported into another account, including accounts with identical names. SDK channel isolation also applies to guest data and migration.

The current package uses cache tag `20261109-2`. See the generated `miniapp/dist/package/package.json` and `SHA256SUMS` for its size and SHA-256 after each rebuild. Guest browser acceptance seeds an existing day-2 SDK guest save, then uses real packaged canvas inputs to continue, reopen, detect platform sign-in and automatically sync through the real Rust/MySQL service; the conflict case first writes the same user's cloud save through production and promotes the guest through sandbox.

Pending server acknowledgements stay in the durable journal and can be retried from the cloud panel. They do not display a bottom banner during play. The bottom retry notice is reserved for local SDK persistence failures.

### 渐进无尽规则 v3

新局与每日 40 人使用相同的服务器进度；按已结算旅客数计数（错判也计，波次不计）：0 地区/照片，5 时区/语言，10 付款/账单/手机，15 测谎/X 光，20 护照有效期/签发城市，25 模型/认证注册表/已认证例外与六位 AI，30 入境许可姓名/目的/有效期，35 网络/登录/通缉/临时规定。规则、证件、破绽、工具、特殊旅客均按阶段生效；鱼旅客从 10 开始且只使用已公布规则。前 15 格无波次，然后每 8 位旅客接 1 波次；既有波次说明在准备阶段显示。

普通/AI 旅客的 clean 抽样阈值为每千分 `max(250, 650 - 8*t)`（特殊旅客有独立策略）；25 前至多 1 个基础破绽，25 起以 35% 抽取 2 个，50 起先以 25% 抽取 3 个、否则继续 2 个抽样，互斥组合仍过滤。临时规定独立核验，不改变计分公式。阈值表达的是确定性抽样概率，不保证单个短序列的合规比例。

RunView 新增 `progression`（v1/v2 为 null）：`stage` 0..7、`completed_travelers`、`active_rules`、`new_rules`、`next_unlock_at`、`next_rules`、`waves_unlocked`；不包含答案。当前旅客按自己的 t 显示；无当前旅客按下一位序号显示。新章先短暂翻页/描边提示，随后保持清楚的静态箭头；点击实际宪法书打开对应 NEW 页后才放行下一位或恢复待处理旅客。已打开的书保留拖动位置，更新到新条款页；阅读确认按 run_id 存入 gameStorage/SDK，成功持久化后生效。存储失败可点击书重试；减弱动效只保留静态提示，完成条件相同。键盘 B 可打开/确认。

发布仍须配套前后端在 UTC+8 午夜切换；本次仅修改发布说明，不执行生产操作。无需数据库 schema 变更或清榜，持久化 v1/v2 的旅客/波次/公告/通缉继续按旧版本；两个旧 golden 均保留。新开局要求 client_rules_version:3，旧客户端新开局返回 409，旧局恢复不变。

渐进模式回归：`npm run test:progressive --prefix miniapp`（先 build），包含定位阶段的源码/最终 IIFE 桌面、触控、减弱动效截图，不冒充自然通关。ZIP manifest 仍为本地候选版本；正式发布需按平台要求递增 manifest 版本并重新构建、记录 hash，再执行单独授权的午夜切换。
