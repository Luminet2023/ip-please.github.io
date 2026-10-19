// 前端云同步集成测试（jsdom）：真实加载 cloud.js，模拟 IdP 与后端响应。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const CLOUD_JS = fs.readFileSync(path.join(REPO, 'cloud.js'), 'utf8');
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

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (sub) =>
  b64url({ alg: 'RS256', kid: 'k1' }) + '.' + b64url({ sub: sub || 'subject-1', preferred_username: 'tester' }) + '.sig';

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
  // jsdom 没暴露 TextEncoder/TextDecoder（现代浏览器都有），这里补上以测试 PKCE。
  if (!dom.window.TextEncoder) dom.window.TextEncoder = TextEncoder;
  if (!dom.window.TextDecoder) dom.window.TextDecoder = TextDecoder;
  return dom;
}

function load(dom) {
  vm.runInContext(CLOUD_JS, dom.getInternalVMContext());
  return dom.window;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 80 : ms));

async function testLoginPanelAndCredit() {
  console.log('→ 登录面板与致谢');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = load(dom);
  await wait(60); // 等 jsdom 触发 DOMContentLoaded，cloud.js 的 init 才会执行
  const panel = win.document.getElementById('cloud-panel');
  check('初始面板隐藏', panel.hidden === true);

  win.document.getElementById('cloud').click();
  await wait(20);
  check('点击云同步打开登录面板', panel.hidden === false, panel.hidden);
  check('面板含原作仓库链接', panel.innerHTML.indexOf('github.com/ip-please/ip-please.github.io') >= 0);
  check('面板说明仅新增云同步', panel.textContent.indexOf('仅新增云存档同步') >= 0, panel.textContent);
  check('面板含致谢', panel.textContent.indexOf('致谢') >= 0);
  check('面板有登录按钮', Array.from(panel.querySelectorAll('button')).some((button) => button.textContent === '登录'));

  const loginButton = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === '登录');
  loginButton.click();
  await wait(40);
  const pkce = JSON.parse(win.sessionStorage.getItem('ip-please-pkce-v1') || 'null');
  check('登录发起 PKCE', !!pkce && pkce.verifier.length >= 43 && !!pkce.state, pkce);
}

async function testCallbackAndDayEnd() {
  console.log('→ 登录回调与日终上传');
  const dom = newDom('https://www.fuckanthropic.dev/?code=auth-code-1&state=st-1&session_state=abc');
  const win = dom.window;
  win.sessionStorage.setItem('ip-please-pkce-v1', JSON.stringify({ verifier: 'v'.repeat(43), state: 'st-1' }));

  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/protocol/openid-connect/token')) {
      const body = new URLSearchParams(options.body);
      if (body.get('grant_type') === 'authorization_code') {
        return makeRes(200, { access_token: fakeJwt('subject-1'), refresh_token: 'rt-1', expires_in: 600 });
      }
      return makeRes(200, { access_token: fakeJwt('subject-1'), refresh_token: 'rt-2', expires_in: 600 });
    }
    if (String(url).endsWith('/sync/save')) {
      return makeRes(404, { detail: 'The requested resource was not found.' });
    }
    return makeRes(500, { detail: 'unexpected' });
  };

  load(dom);
  await wait(120);
  const stored = JSON.parse(win.localStorage.getItem('ip-please-auth-v1') || 'null');
  check('授权码换 token', !!stored && stored.refresh_token === 'rt-1', stored);
  check('保存 subject', !!stored && stored.subject === 'subject-1');
  check('登录态生效', win.CloudSync.isLoggedIn() === true);
  check('回调参数清理', win.location.search === '');
  check('PKCE 已清理', win.sessionStorage.getItem('ip-please-pkce-v1') === null);
  const tokenCall = calls.find((call) => String(call.url).includes('/token'));
  check('带 code_verifier', new URLSearchParams(tokenCall.options.body).get('code_verifier') === 'v'.repeat(43));

  win.fetch = async (url, options) => {
    if (String(url).endsWith('/sync/save') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      check('base_version=0', body.base_version === 0, body.base_version);
      check('payload 完整', body.payload && body.payload.savings === 5, body.payload);
      check('携带 Bearer', (options.headers.Authorization || '').startsWith('Bearer '));
      return makeRes(200, {
        user_id: 'user_abcdefghijklmnopqrstuv', save_id: 'save_abcdefghijklmnopqrstuv',
        version: 1, day: 2, updated_at: '2026-10-19T03:00:00.000Z',
      });
    }
    return makeRes(500, null);
  };
  await win.CloudSync.onDayEnd({ day: 2, savings: 5 });
  await wait(20);
  const meta = JSON.parse(win.localStorage.getItem('ip-please-sync-meta-v1:subject-1') || 'null');
  check('元数据版本写入', !!meta && meta.version === 1, meta);
  check('同步提示', win.document.getElementById('toast').textContent.indexOf('已同步') >= 0);
}

async function testConflict() {
  console.log('→ 冲突处理');
  const dom = newDom('https://www.fuckanthropic.dev/');
  const win = dom.window;
  win.localStorage.setItem('ip-please-auth-v1', JSON.stringify({
    access_token: fakeJwt('subject-1'), refresh_token: 'rt-1',
    expires_at: Date.now() + 600000, subject: 'subject-1', name: 'tester',
  }));
  win.localStorage.setItem('ip-please-sync-meta-v1:subject-1', JSON.stringify({ version: 1, day: 2 }));
  const uploads = [];
  win.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith('/sync/save') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      uploads.push(body);
      if (body.base_version === 1) return makeRes(409, { detail: 'The cloud save has a newer version than the client base version.' });
      return makeRes(200, { user_id: 'user_abcdefghijklmnopqrstuv', save_id: 'save_b', version: body.base_version + 1, day: body.day, updated_at: '2026-10-19T04:00:00.000Z' });
    }
    return makeRes(200, { user_id: 'user_abcdefghijklmnopqrstuv', save_id: 'save_c', version: 5, day: 4, updated_at: '2026-10-19T04:30:00.000Z', payload: { day: 4 } });
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
  win.localStorage.setItem('ip-please-auth-v1', JSON.stringify({
    access_token: fakeJwt('subject-1'), refresh_token: 'rt-old', expires_at: Date.now() + 600000, subject: 'subject-1',
  }));
  let refreshCount = 0;
  let saveCalls = 0;
  win.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/protocol/openid-connect/token')) {
      refreshCount += 1;
      return makeRes(200, { access_token: fakeJwt('subject-1'), refresh_token: 'rt-new', expires_in: 600 });
    }
    saveCalls += 1;
    if (saveCalls === 1) return makeRes(401, { error: { message: 'expired', code: 'invalid_token' }, status: 401 });
    return makeRes(200, { user_id: 'user_abcdefghijklmnopqrstuv', save_id: 'save_e', version: 3, day: 2, updated_at: '2026-10-19T06:00:00.000Z', payload: { day: 2 } });
  };
  load(dom);
  await wait(40);
  await win.CloudSync.restore();
  await wait(80);
  check('401 触发 refresh', refreshCount === 1, refreshCount);
  check('刷新后重试', saveCalls === 2, saveCalls);
  check('新 RT 已保存', JSON.parse(win.localStorage.getItem('ip-please-auth-v1')).refresh_token === 'rt-new');

  const dom2 = newDom('https://www.fuckanthropic.dev/');
  const win2 = dom2.window;
  win2.localStorage.setItem('ip-please-auth-v1', JSON.stringify({
    access_token: fakeJwt('subject-1'), refresh_token: 'rt-1', expires_at: Date.now() + 600000, subject: 'subject-1',
  }));
  win2.fetch = async () => makeRes(401, { error: { message: 'revoked', code: 'token_revoked' }, status: 401 });
  load(dom2);
  await wait(40);
  await win2.CloudSync.restore();
  await wait(60);
  check('revoked 清除登录态', win2.localStorage.getItem('ip-please-auth-v1') === null);
  check('revoked 后未登录', win2.CloudSync.isLoggedIn() === false);
}

(async function main() {
  await testLoginPanelAndCredit();
  await testCallbackAndDayEnd();
  await testConflict();
  await testRefreshAndRevoke();
  console.log('');
  if (failures.length) {
    console.log('FAILED ' + failures.length + '/' + checks + ': ' + failures.join(', '));
    process.exit(1);
  }
  console.log('ALL ' + checks + ' FRONTEND CHECKS PASSED');
})();
