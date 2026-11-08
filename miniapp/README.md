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

`game-host.js` provides an account-scoped synchronous storage mirror over the asynchronous SDK store. The namespace uses the backend's stable `user_*`, itself scoped by verified issuer/app/channel/sub; SDK storage also isolates channel. Credentials and avatar URLs are never persisted. Day/ending transitions wait for all dirty revisions. Failed persistence keeps the transition callback and dirty memory available to Retry.

Actions write a durable journal before transport. Timeout, offline, 401, 429 and 5xx preserve the original `req_*`, operation and args; SDK 401 reauthorization retries the same envelope. A known terminal response acknowledges the journal; a failed acknowledgement write retains its in-memory request. New, different actions wait until existing unknown actions are recovered. Save acknowledgements update the cloud base version together with the journal. Reopening shows Retry for unresolved actions. Conflicts retain the existing explicit cloud/local choice; stale run retries use current/run queries.

The only network declarations are the four fixed platform-authenticated `/anthropic/v1/mapp/` endpoints. `bootstrap.channel` is returned from the verified server principal and labels sandbox/production boards; neither launch arguments nor client state chooses the backend channel. Profile fields are presentation only. Avatar lookup accepts only exact decimal safe integers, starts when visible, coalesces per session, uses SDK Blob URLs, and falls back to initials.

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
node miniapp/tests/visual.cjs
```

The backend browser script starts the **real Rust router and MySQL store** via a test-only example. A loopback parent bridge signs requests using the repository's public test ES256 key and serves its JWKS; signatures, query binding, transactions, receipts, scoring and board queries execute in Rust. Game timing checks remain enabled; request burst throttling is disabled in this fixture. No Authorization header/token enters screenshots or call reports. The bridge and keys remain outside the ZIP and production binary. This is stronger local integration evidence, still not a real LINUX DO account/session, platform permission, public proxy or production deployment test.

The separate visual scene audit uses actual shared-source Canvas PNG rendering for all six new AI (plus existing cast), eight expressions, four languages, long translated documents and actual `fieldAt` targets. Its fixture scene setup is explicitly separate from built-IIFE real mouse/touch play; it does not claim a natural 14-day browser playthrough. The deterministic story suite covers all 14 days and 30 endings.

Storage concurrency uses the pinned SDK `localStorage.exportData()` snapshot (`{format:1, entries:[[key,value],...]}`) and transactional `importData()` **merge**, under the existing `storage.read/write` permissions. Each account/channel has independent dirty-key records; removal writes a tombstone. The original account blob is a read-only migration base. A preference-only flush cannot rewrite a save. Two intentional writes to the same ordinary key use last completed write semantics, matching the single local save slot. Open mirrors refresh during flush/recovery; another window's changes are not pushed into a running game.

Ending IDs are unioned via separate records. Each original `req_*` envelope has its own record; acknowledgements use separate keys and always dominate late journal writes. A save acknowledgement contains its version metadata atomically; hydration takes the highest acknowledged version, so an older delayed response cannot roll it back. Save conflicts remain pending until explicit cloud/local choice; local choice atomically journals the replacement request and acknowledges the rejected one. No Web Locks, origin assumptions, advisory lock or second-window restriction is used. Acknowledgement/history keys are retained to prevent delayed writers resurrecting operations; storage use therefore grows with actions. Failed quota/storage operations retain dirty state and show Retry. Cross-device synchronization remains the cloud protocol, not SDK storage.

Release website HTML and all referenced local JS as one immutable release. The current cache tag `20261108-2` matches `BUILD_VERSION=2026.11.08.2`; every script, including `game-host.js`, carries it. After the final source edit rebuild the ZIP and record its new `SHA256SUMS`, then follow the atomic publication/cache checks in `deploy/README.md`.
