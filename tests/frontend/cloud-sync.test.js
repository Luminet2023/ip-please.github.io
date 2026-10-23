// 前端云同步集成测试（jsdom）：真实加载 cloud.js，模拟后端响应。
// 登录由后端完成换码（/auth/login → IdP → /auth/callback），前端不再直连 IdP 的 Token 端点。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const CONFIG_JS = fs.readFileSync(path.join(REPO, 'config.js'), 'utf8');
const CLOUD_JS = fs.readFileSync(path.join(REPO, 'cloud.js'), 'utf8');
const ENDLESS_JS = fs.readFileSync(path.join(REPO, 'endless.js'), 'utf8');
const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) console.log('  ok   ' + name);
  else {
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
    failures.push(name);
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256b64url = (text) => b64url(crypto.createHash('sha256').update(text).digest());
const USER = { user_id: 'user_abcdefghijklmnopqrstuv', display_name: '小鱼干', avatar_url: 'https://cdn.test/fish.png', tag: 'BEEF', is_admin: false };
const unix = (offsetSecs) => Math.floor(Date.now() / 1000) + offsetSecs;

function tokenResponse(n, extra) {
  return Object.assign({
    token_type: 'Bearer', access_token: 'at-' + n, expires_in: 600, expires_at: unix(600),
    refresh_token: ('rt' + n).padEnd(43, 'x'), refresh_expires_at: unix(86400),
    session_id: 'sess_abcdefghijklmnopqrstuv', session_expires_at: unix(86400 * 30), user: USER,
  }, extra || {});
}

function seedAuth(win, overrides) {
  win.localStorage.setItem('ip-please-auth-v2', JSON.stringify(Object.assign({
    access_token: 'at-1', refresh_token: 'rt1'.padEnd(43, 'x'), expires_at: Date.now() + 600000,
    session_id: 'sess_abcdefghijklmnopqrstuv', user: USER,
  }, overrides || {})));
}

function makeRes(status, body, headers) {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  const lower = {};
  Object.keys(headers || {}).forEach((key) => { lower[key.toLowerCase()] = headers[key]; });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    text: async () => text,
  };
}

const authError = (code) => ({ error: { message: code, type: null, code, param: null }, status: 401 });

function newDom(url) {
  const html = `<!doctype html><html><body>
    <button id="cloud" type="button">云同步</button>
    <div id="toast" class="toast"></div>
    <div id="cloud-panel" class="panel" hidden></div>
    <div id="cloud-overlay" class="overlay" hidden></div>
  </body></html>`;
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new (require('jsdom').VirtualConsole)(),
  });
  if (!dom.window.crypto || !dom.window.crypto.subtle) {
    Object.defineProperty(dom.window, 'crypto', { value: require('crypto').webcrypto, configurable: true });
  }
  // jsdom 没暴露 TextEncoder/TextDecoder（现代浏览器都有），这里补上以测试 SHA-256。
  if (!dom.window.TextEncoder) dom.window.TextEncoder = TextEncoder;
  if (!dom.window.TextDecoder) dom.window.TextDecoder = TextDecoder;
  return dom;
}

function load(dom) {
  // 与 index.html 同序：config.js 先于 cloud.js（存档键来自 STORAGE_KEYS）
  vm.runInContext(CONFIG_JS, dom.getInternalVMContext());
  vm.runInContext(CLOUD_JS, dom.getInternalVMContext());
  return dom.window;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 80 : ms));
const toastText = (win) => win.document.getElementById('toast').textContent;

async function testLoginPanelAndCredit() {
  console.log('→ 登录面板、致谢与发起登录');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return makeRes(200, {
      authorize_url: 'https://auth.luminet.cn/realms/prod/protocol/openid-connect/auth?state=st-1',
      state: 'st-1', expires_at: unix(600),
    });
  };
  load(dom);
  await wait(60); // 等 jsdom 触发 DOMContentLoaded，cloud.js 的 init 才会执行
  const panel = win.document.getElementById('cloud-panel');
  check('初始面板隐藏', panel.hidden === true);

  win.document.getElementById('cloud').click();
  await wait(20);
  check('点击云同步打开登录面板', panel.hidden === false, panel.hidden);
  check('面板含原作仓库链接', panel.innerHTML.indexOf('github.com/ip-please/ip-please.github.io') >= 0);
  check('面板含零号档案 mod 链接', panel.innerHTML.indexOf('github.com/wess09/ip-please-zero') >= 0);
  check('面板说明新增云同步', panel.textContent.indexOf('新增云存档同步') >= 0, panel.textContent);
  check('面板含致谢', panel.textContent.indexOf('致谢') >= 0);
  check('面板有登录按钮', Array.from(panel.querySelectorAll('button')).some((button) => button.textContent === '登录'));

  const loginButton = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === '登录');
  loginButton.click();
  await wait(60);
  const loginCall = calls.find((call) => call.url.endsWith('/auth/login'));
  check('向后端发起登录', !!loginCall && loginCall.options.method === 'POST');
  const body = loginCall ? JSON.parse(loginCall.options.body) : {};
  check('只发送 login_challenge（43 位）', typeof body.login_challenge === 'string' && body.login_challenge.length === 43, body);
  check('带回调地址', body.redirect_uri === 'https://www.fuckanthropic.dev/', body.redirect_uri);
  check('发起登录不带 Bearer', !(loginCall && loginCall.options.headers.Authorization));
  const pending = JSON.parse(win.sessionStorage.getItem('ip-please-login-v2') || 'null');
  check('会话存储保存 state 与 verifier', !!pending && pending.state === 'st-1' && pending.verifier.length >= 43, pending);
  check('challenge = SHA256(verifier)', !!pending && sha256b64url(pending.verifier) === body.login_challenge);
  check('不再直连 IdP Token 端点', !calls.some((call) => call.url.indexOf('openid-connect/token') >= 0));
}

async function testForeignAuthorizeUrl() {
  console.log('→ 拒绝非 IdP 的授权地址');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  win.fetch = async () => makeRes(200, { authorize_url: 'https://evil.example/login', state: 'st-x', expires_at: unix(600) });
  load(dom);
  await wait(40);
  await win.CloudSync.login();
  check('未保存登录状态', win.sessionStorage.getItem('ip-please-login-v2') === null);
  check('提示地址异常', toastText(win).indexOf('异常') >= 0, toastText(win));
}

async function testCallbackAndDayEnd() {
  console.log('→ 登录回调与日终上传');
  const dom = newDom('https://www.fuckanthropic.dev/?code=auth-code-1&state=st-1&session_state=abc&iss=https%3A%2F%2Fauth.luminet.cn%2Frealms%2Fprod');
  const win = dom.window;
  win.sessionStorage.setItem('ip-please-login-v2', JSON.stringify({ verifier: 'v'.repeat(43), state: 'st-1' }));

  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/callback')) return makeRes(200, tokenResponse(1));
    if (String(url).endsWith('/sync/save')) return makeRes(404, { detail: 'The requested resource was not found.' });
    return makeRes(500, { detail: 'unexpected' });
  };

  load(dom);
  await wait(120);
  const stored = JSON.parse(win.localStorage.getItem('ip-please-auth-v2') || 'null');
  check('保存后端签发的 RT', !!stored && stored.refresh_token === tokenResponse(1).refresh_token, stored);
  check('expires_at 换算成毫秒', !!stored && Math.abs(stored.expires_at - (unix(600) * 1000)) < 5000, stored && stored.expires_at);
  check('保存会话与用户', !!stored && stored.session_id.startsWith('sess_') && stored.user.user_id === USER.user_id);
  check('登录态生效', win.CloudSync.isLoggedIn() === true);
  check('user() 返回 IdP 名字', win.CloudSync.user().display_name === USER.display_name);
  check('回调参数清理', win.location.search === '');
  check('登录状态已清理', win.sessionStorage.getItem('ip-please-login-v2') === null);
  const callback = calls.find((call) => call.url.endsWith('/auth/callback'));
  const body = callback ? JSON.parse(callback.options.body) : {};
  check('回调出示 verifier', body.login_verifier === 'v'.repeat(43) && body.code === 'auth-code-1' && body.state === 'st-1', body);
  check('回调带 iss', body.iss === 'https://auth.luminet.cn/realms/prod', body.iss);
  // 不设 Content-Type（默认 text/plain，不带 Token 的请求不触发预检），也不设 cache（否则 Chrome 不用预检缓存）
  const sentHeaders = callback ? callback.options.headers : {};
  check('请求不设 Content-Type', !!callback && !Object.keys(sentHeaders).some((k) => k.toLowerCase() === 'content-type'),
    sentHeaders);
  check('请求不设 fetch cache 选项', !!callback && callback.options.cache === undefined, callback && callback.options.cache);

  win.fetch = async (url, options) => {
    if (String(url).endsWith('/sync/save') && options.method === 'POST') {
      const upload = JSON.parse(options.body);
      check('base_version=0', upload.base_version === 0, upload.base_version);
      check('payload 完整', upload.payload && upload.payload.savings === 5, upload.payload);
      check('携带本服务 AT', options.headers.Authorization === 'Bearer at-1', options.headers.Authorization);
      return makeRes(200, {
        user_id: USER.user_id, save_id: 'save_abcdefghijklmnopqrstuv',
        version: 1, day: 2, updated_at: '2026-10-19T03:00:00.000Z',
      });
    }
    return makeRes(500, null);
  };
  await win.CloudSync.onDayEnd({ day: 2, savings: 5 });
  await wait(20);
  const meta = JSON.parse(win.localStorage.getItem('ip-please-sync-meta-v1:' + USER.user_id) || 'null');
  check('元数据按 user_id 写入', !!meta && meta.version === 1, meta);
  check('同步提示', toastText(win).indexOf('已同步') >= 0);
}

async function testStateMismatch() {
  console.log('→ state 不符时不调用后端');
  const dom = newDom('https://www.fuckanthropic.dev/?code=c&state=forged');
  const win = dom.window;
  win.sessionStorage.setItem('ip-please-login-v2', JSON.stringify({ verifier: 'v'.repeat(43), state: 'st-1' }));
  let called = 0;
  win.fetch = async () => { called += 1; return makeRes(200, tokenResponse(1)); };
  load(dom);
  await wait(60);
  check('未调用 /auth/callback', called === 0, called);
  check('未登录', win.CloudSync.isLoggedIn() === false);
  check('提示校验失败', toastText(win).indexOf('校验失败') >= 0, toastText(win));
}

async function testLegacyAuthDropped() {
  console.log('→ 旧版登录态清理');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  win.localStorage.setItem('ip-please-auth-v1', JSON.stringify({ access_token: 'kc', refresh_token: 'kc-rt' }));
  win.fetch = async () => makeRes(500, null);
  load(dom);
  await wait(40);
  check('v1 键已删除', win.localStorage.getItem('ip-please-auth-v1') === null);
  check('保持未登录', win.CloudSync.isLoggedIn() === false);
  check('提示重新登录一次', toastText(win).indexOf('重新登录') >= 0, toastText(win));
}

async function testConflict() {
  console.log('→ 冲突处理');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win);
  win.localStorage.setItem('ip-please-sync-meta-v1:' + USER.user_id, JSON.stringify({ version: 1, day: 2 }));
  const uploads = [];
  win.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith('/sync/save') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      uploads.push(body);
      if (body.base_version === 1) return makeRes(409, { detail: 'The cloud save has a newer version than the client base version.' });
      return makeRes(200, { user_id: USER.user_id, save_id: 'save_b', version: body.base_version + 1, day: body.day, updated_at: '2026-10-19T04:00:00.000Z' });
    }
    return makeRes(200, { user_id: USER.user_id, save_id: 'save_c', version: 5, day: 4, updated_at: '2026-10-19T04:30:00.000Z', payload: { day: 4, plot: { final: {} } } });
  };
  load(dom);
  await wait(40);
  await win.CloudSync.onDayEnd({ day: 3, savings: 7 });
  await wait(60);
  const overlay = win.document.getElementById('cloud-overlay');
  check('冲突弹窗出现', overlay.hidden === false);
  check('弹窗说明天数', overlay.textContent.indexOf('第 4 天') >= 0 && overlay.textContent.indexOf('第 3 天') >= 0);
  const keepLocal = Array.from(overlay.querySelectorAll('button')).find((button) => button.textContent === '保留本机');
  keepLocal.click();
  await wait(100);
  check('以云端版本为基线覆盖', uploads.length === 2 && uploads[1].base_version === 5, uploads.map((item) => item.base_version));
  check('弹窗已关闭', win.document.getElementById('cloud-overlay').hidden === true);
}

async function testRefreshAndRevoke() {
  console.log('→ 401 刷新 / 吊销登出');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win, { refresh_token: 'rt-old'.padEnd(43, 'x') });
  let refreshCount = 0;
  let saveCalls = 0;
  let refreshBody = null;
  win.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith('/auth/refresh')) {
      refreshCount += 1;
      refreshBody = JSON.parse(options.body);
      return makeRes(200, tokenResponse(2));
    }
    saveCalls += 1;
    if (saveCalls === 1) return makeRes(401, authError('invalid_token'));
    return makeRes(200, { user_id: USER.user_id, save_id: 'save_e', version: 3, day: 2, updated_at: '2026-10-19T06:00:00.000Z', payload: { day: 2, plot: { final: {} } } });
  };
  load(dom);
  await wait(40);
  await win.CloudSync.restore();
  await wait(80);
  check('401 触发 refresh', refreshCount === 1, refreshCount);
  check('刷新带旧 RT', refreshBody && refreshBody.refresh_token === 'rt-old'.padEnd(43, 'x'));
  check('刷新后重试', saveCalls === 2, saveCalls);
  check('新 RT 已保存', JSON.parse(win.localStorage.getItem('ip-please-auth-v2')).refresh_token === tokenResponse(2).refresh_token);

  const dom2 = newDom('https://www.fuckanthropic.dev/');
  const win2 = dom2.window;
  seedAuth(win2);
  win2.fetch = async () => makeRes(401, authError('token_revoked'));
  load(dom2);
  await wait(40);
  await win2.CloudSync.restore();
  await wait(60);
  check('revoked 清除登录态', win2.localStorage.getItem('ip-please-auth-v2') === null);
  check('revoked 后未登录', win2.CloudSync.isLoggedIn() === false);

  // 刷新本身返回 token_revoked（会话被 IdP 反向通道注销）→ 登出
  const dom3 = newDom('https://www.fuckanthropic.dev/');
  const win3 = dom3.window;
  seedAuth(win3, { expires_at: Date.now() - 1000 });
  win3.fetch = async (url) => (String(url).endsWith('/auth/refresh')
    ? makeRes(401, authError('token_revoked'))
    : makeRes(500, null));
  load(dom3);
  await wait(40);
  await win3.CloudSync.restore();
  await wait(60);
  check('刷新被拒后登出', win3.CloudSync.isLoggedIn() === false);
}

async function testSingleRefreshForParallelCalls() {
  console.log('→ 并发请求只刷新一次');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win, { expires_at: Date.now() - 1000 });
  let refreshCount = 0;
  const bearers = [];
  win.fetch = async (url, options) => {
    if (String(url).endsWith('/auth/refresh')) {
      refreshCount += 1;
      await wait(30);
      return makeRes(200, tokenResponse(7));
    }
    bearers.push(options.headers.Authorization);
    return makeRes(200, { ok: true });
  };
  load(dom);
  await wait(40);
  await Promise.all([win.CloudSync.api('/me'), win.CloudSync.api('/me'), win.CloudSync.api('/me')]);
  check('只刷新一次', refreshCount === 1, refreshCount);
  check('全部用新 AT', bearers.length === 3 && bearers.every((value) => value === 'Bearer at-7'), bearers);
}

async function testStaleRefreshAdoptsOtherTab() {
  console.log('→ 其他标签页已轮换 RT 时沿用其结果');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win, { expires_at: Date.now() - 1000 });
  win.fetch = async (url) => {
    if (String(url).endsWith('/auth/refresh')) {
      // 模拟另一个标签页刚刚换过：存储里已经是新 Token，本页拿旧 RT 刷新落在宽限期
      win.localStorage.setItem('ip-please-auth-v2', JSON.stringify({
        access_token: 'at-other', refresh_token: 'rt-other'.padEnd(43, 'x'), expires_at: Date.now() + 600000,
        session_id: 'sess_abcdefghijklmnopqrstuv', user: USER,
      }));
      return makeRes(401, authError('invalid_token'));
    }
    return makeRes(200, { ok: true });
  };
  load(dom);
  await wait(40);
  let failed = null;
  try {
    await win.CloudSync.api('/me');
  } catch (error) {
    failed = error;
  }
  check('没有被登出', win.CloudSync.isLoggedIn() === true && !failed, failed && failed.message);
}

async function openPanelWith(user) {
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win, { user });
  win.fetch = async () => makeRes(200, { status: 'ok' });
  load(dom);
  await wait(40);
  win.document.getElementById('cloud').click();
  await wait(20);
  return win;
}

async function testPanelAvatar() {
  console.log('→ 面板显示 IdP 名字与头像');
  let win = await openPanelWith(USER);
  let panel = win.document.getElementById('cloud-panel');
  const who = panel.querySelector('.who');
  check('面板显示 IdP 名字', !!who && who.textContent.indexOf('小鱼干') >= 0, panel.textContent);
  check('不再有改昵称表单', !panel.querySelector('input') && panel.textContent.indexOf('昵称') < 0, panel.innerHTML);
  let img = panel.querySelector('img.avatar');
  check('头像用 IdP 图片', !!img && img.getAttribute('src') === USER.avatar_url, panel.innerHTML);
  check('头像不带 Referer', !!img && img.getAttribute('referrerpolicy') === 'no-referrer');
  img.dispatchEvent(new win.Event('error'));
  const fallback = panel.querySelector('.avatar');
  check('图片加载失败换成首字头像', !panel.querySelector('img.avatar') && !!fallback && fallback.textContent === '小',
    panel.innerHTML);

  win = await openPanelWith(Object.assign({}, USER, { display_name: 'claude', avatar_url: null, is_admin: true }));
  panel = win.document.getElementById('cloud-panel');
  const letter = panel.querySelector('span.avatar');
  check('没有头像时显示首字', !panel.querySelector('img') && !!letter && letter.textContent === 'C', panel.innerHTML);
  check('首字头像按 tag 取色', !!letter && letter.style.background !== '', letter && letter.getAttribute('style'));
  check('管理员标记', panel.querySelector('.who').textContent.indexOf('管理员') >= 0);

  win = await openPanelWith(Object.assign({}, USER, { display_name: '<img src=x onerror=alert(1)>', avatar_url: 'javascript:alert(1)' }));
  panel = win.document.getElementById('cloud-panel');
  check('名字按文本显示', panel.querySelectorAll('img').length === 0 && panel.querySelector('.who .name').textContent === '<img src=x onerror=alert(1)>',
    panel.innerHTML);

  // 升级前存下的登录态没有 display_name：显示「审查员」，不再显示旧的「审查员-XXXX」
  win = await openPanelWith({ user_id: USER.user_id, nickname: '审查员-AB12', nickname_set: false, tag: 'BEEF', is_admin: false });
  panel = win.document.getElementById('cloud-panel');
  check('旧登录态显示默认名字', panel.querySelector('.who .name').textContent === '审查员' && panel.textContent.indexOf('AB12') < 0,
    panel.textContent);
}

async function testLeaderboardAvatars() {
  console.log('→ 排行榜显示 IdP 名字与头像');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win);
  win.fetch = async (url) => {
    if (String(url).indexOf('/endless/leaderboard') >= 0) {
      return makeRes(200, {
        board: 'endless', period: 'all', me: { rank: 2, score: 300 },
        entries: [
          { rank: 1, display_name: 'Opus', avatar_url: 'https://cdn.test/opus.png', tag: '0A1F', score: 900, me: false },
          { rank: 2, display_name: '小鱼干', avatar_url: null, tag: 'BEEF', score: 300, me: true },
        ],
      });
    }
    return makeRes(200, { status: 'ok' });
  };
  load(dom);
  // endless.js 只用到 T() 做文案替换，这里给个最小实现
  vm.runInContext("var T = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);", dom.getInternalVMContext());
  vm.runInContext(ENDLESS_JS, dom.getInternalVMContext());
  await win.Endless.openLeaderboard('endless');
  await wait(20);
  const rows = Array.from(win.document.querySelectorAll('#cloud-overlay ol.board li'));
  check('排行榜两行', rows.length === 2, rows.length);
  const first = rows[0];
  check('第一名用 IdP 头像', !!first && !!first.querySelector('img.avatar') &&
    first.querySelector('img.avatar').getAttribute('src') === 'https://cdn.test/opus.png', first && first.innerHTML);
  check('第一名显示名字', !!first && first.querySelector('.name').textContent === 'Opus');
  const mine = rows[1];
  check('没头像的显示首字', !!mine && mine.classList.contains('me') && mine.querySelector('span.avatar').textContent === '小',
    mine && mine.innerHTML);
  check('不再显示 #标签', rows.every((row) => row.textContent.indexOf('#BEEF') < 0 && row.textContent.indexOf('#0A1F') < 0),
    rows.map((row) => row.textContent));
}

async function testLogout() {
  console.log('→ 登出通知后端');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win);
  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return makeRes(200, { status: 'ok' });
  };
  load(dom);
  await wait(40);

  win.CloudSync.logout();
  await wait(40);
  const logoutCall = calls.find((call) => call.url.endsWith('/auth/logout'));
  check('登出发送 RT', !!logoutCall && JSON.parse(logoutCall.options.body).refresh_token === 'rt1'.padEnd(43, 'x'));
  check('本地已登出', win.CloudSync.isLoggedIn() === false);
}

async function testFileZeroSaves() {
  console.log('→ 零号档案存档：旧版 / 已完结的云端存档不载入');
  const latest = (payload) => makeRes(200, {
    user_id: USER.user_id, save_id: 'save_l', version: 7, day: payload.day,
    updated_at: '2026-10-19T07:00:00.000Z', payload,
  });

  // 旧版 6 天存档（没有 plot）：手动恢复只提示，不弹载入框
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win);
  win.fetch = async () => latest({ day: 4, savings: 3 });
  load(dom);
  await wait(40);
  await win.CloudSync.restore();
  await wait(40);
  check('旧版云端存档不弹载入框', win.document.getElementById('cloud-overlay').hidden === true);
  check('提示旧版存档读不了', toastText(win).indexOf('旧版') >= 0, toastText(win));

  // 日终冲突时云端是旧版存档：直接用本机进度覆盖，不让玩家选旧存档
  win.localStorage.setItem('ip-please-sync-meta-v1:' + USER.user_id, JSON.stringify({ version: 1, day: 2 }));
  const uploads = [];
  win.fetch = async (url, options) => {
    if (String(url).endsWith('/sync/save') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      uploads.push(body.base_version);
      if (body.base_version === 1) return makeRes(409, { detail: 'The cloud save has a newer version than the client base version.' });
      return makeRes(200, { user_id: USER.user_id, save_id: 'save_m', version: 8, day: body.day, updated_at: '2026-10-19T07:10:00.000Z' });
    }
    return latest({ day: 4, savings: 3 });
  };
  await win.CloudSync.onDayEnd({ day: 3, savings: 7, plot: { final: {} } });
  await wait(80);
  check('旧版冲突不弹窗', win.document.getElementById('cloud-overlay').hidden === true);
  check('旧版冲突直接覆盖云端', uploads.length === 2 && uploads[1] === 7, uploads);

  // 已打出结局的零号档案存档：同样没有可接着玩的进度
  win.fetch = async () => latest({ day: 9, plot: { final: { ending: 'E23' } } });
  await win.CloudSync.restore();
  await wait(40);
  check('已完结存档不弹载入框', win.document.getElementById('cloud-overlay').hidden === true);
  check('提示那一局已打完', toastText(win).indexOf('打完') >= 0, toastText(win));

  // 可接着玩的存档：载入写进零号档案的存档键
  win.fetch = async () => latest({ day: 5, plot: { final: {} } });
  await win.CloudSync.restore();
  await wait(40);
  const load5 = Array.from(win.document.querySelectorAll('#cloud-overlay button')).find((button) => button.textContent === '载入云端');
  check('零号档案存档可载入', !!load5);
  if (load5) load5.click();
  await wait(20);
  const saved = JSON.parse(win.localStorage.getItem('ip-please-file-zero-save-v1') || 'null');
  check('写入零号档案存档键', !!saved && saved.day === 5, saved);
  check('不写原版存档键', win.localStorage.getItem('ip-please-save-v1') === null);
}

async function testNewErrorCodes() {
  console.log('→ 新错误码文案');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  seedAuth(win);
  win.fetch = async () => makeRes(429, { detail: 'Too many requests. Please retry later.' }, { 'Retry-After': '9' });
  load(dom);
  await wait(40);
  let error = null;
  try {
    await win.CloudSync.api('/endless/runs', { method: 'POST', body: {} });
  } catch (err) {
    error = err;
  }
  check('rate_limited 映射', error && error.code === 'rate_limited' && error.retryAfter === 9, error && error.code);
  win.fetch = async () => makeRes(409, { detail: "Today's daily challenge has already been played." });
  try {
    await win.CloudSync.api('/endless/runs', { method: 'POST', body: {} });
  } catch (err) {
    error = err;
  }
  check('daily_already_played 映射', error.code === 'daily_already_played' && error.message.indexOf('每日挑战') >= 0, error.code);
}

(async function main() {
  await testLoginPanelAndCredit();
  await testForeignAuthorizeUrl();
  await testCallbackAndDayEnd();
  await testStateMismatch();
  await testLegacyAuthDropped();
  await testConflict();
  await testRefreshAndRevoke();
  await testSingleRefreshForParallelCalls();
  await testStaleRefreshAdoptsOtherTab();
  await testPanelAvatar();
  await testLeaderboardAvatars();
  await testLogout();
  await testFileZeroSaves();
  await testNewErrorCodes();
  console.log('');
  if (failures.length) {
    console.log('FAILED ' + failures.length + '/' + checks + ': ' + failures.join(', '));
    process.exit(1);
  }
  console.log('ALL ' + checks + ' FRONTEND CHECKS PASSED');
})();
