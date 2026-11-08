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
