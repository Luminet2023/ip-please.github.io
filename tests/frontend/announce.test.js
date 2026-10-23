// 公告前端测试（jsdom）：真实加载 config.js + cloud.js + announce.js。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const SOURCES = ['config.js', 'cloud.js', 'announce.js'].map((file) => fs.readFileSync(path.join(REPO, file), 'utf8'));
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

function makeRes(status, body) {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
}

const USER = { user_id: 'user_abcdefghijklmnopqrstuv', nickname: '审查员-AB12', nickname_set: false, tag: 'BEEF', is_admin: false };
const XSS = '<img src=x onerror="window.pwned=1">';
const ITEMS = [
  { announcement_id: 'ann_aaaaaaaaaaaaaaaaaaaaaa', title: XSS + '维护', body: '今晚 22:00\n停机', level: 'maintenance', starts_at: '2026-10-24T00:00:00.000Z', ends_at: null, created_at: '2026-10-24T00:00:00.000Z' },
  { announcement_id: 'ann_bbbbbbbbbbbbbbbbbbbbbb', title: '旧公告', body: '第二条', level: 'info', starts_at: '2026-10-23T00:00:00.000Z', ends_at: null, created_at: '2026-10-23T00:00:00.000Z' },
];

function newDom(storage) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="cloud" type="button">云同步</button>
    <div id="toast"></div>
    <div id="announce" class="announce" hidden></div>
    <div id="cloud-panel" class="panel" hidden></div>
    <div id="cloud-overlay" class="overlay" hidden></div>
  </body></html>`, {
    url: 'https://www.fuckanthropic.dev/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new (require('jsdom').VirtualConsole)(),
  });
  Object.entries(storage || {}).forEach(([key, value]) => dom.window.localStorage.setItem(key, value));
  return dom;
}

function load(dom) {
  SOURCES.forEach((source) => vm.runInContext(source, dom.getInternalVMContext()));
  return dom.window;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 60 : ms));

function seedAuth(win, user) {
  win.localStorage.setItem('ip-please-auth-v2', JSON.stringify({
    access_token: 'at-1', refresh_token: 'rt1'.padEnd(43, 'x'), expires_at: Date.now() + 600000,
    session_id: 'sess_abcdefghijklmnopqrstuv', user: user,
  }));
}

async function testBannerAndDismiss() {
  console.log('→ 横幅显示与关闭');
  const dom = newDom();
  const win = dom.window;
  const calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return makeRes(200, { announcements: ITEMS });
  };
  load(dom);
  await wait(80);
  const banner = win.document.getElementById('announce');
  check('横幅可见', banner.hidden === false);
  check('公开接口不带 Token', calls.length > 0 && !calls[0].options.headers.Authorization);
  check('显示最新一条', banner.textContent.indexOf('维护') >= 0 && banner.textContent.indexOf('停机') >= 0, banner.textContent);
  check('XSS 只作为文本', banner.querySelector('img') === null && banner.textContent.indexOf('<img') >= 0 && !win.pwned);
  check('维护级别样式', banner.className.indexOf('level-maintenance') >= 0, banner.className);

  banner.querySelector('button').click();
  await wait(10);
  check('关掉后显示下一条', banner.textContent.indexOf('第二条') >= 0, banner.textContent);
  banner.querySelector('button').click();
  await wait(10);
  check('全部关掉后隐藏', banner.hidden === true);
  const dismissed = JSON.parse(win.localStorage.getItem('ip-please-announce-dismissed-v1'));
  check('记住关掉的公告', dismissed.length === 2, dismissed);

  // 刷新页面：记住的公告不再出现；已下线的 ID 被清掉
  const dom2 = newDom({ 'ip-please-announce-dismissed-v1': JSON.stringify(dismissed.concat(['ann_retiredretiredretired00'])) });
  const win2 = dom2.window;
  win2.fetch = async () => makeRes(200, { announcements: ITEMS });
  load(dom2);
  await wait(80);
  check('重开页面仍隐藏', win2.document.getElementById('announce').hidden === true);
  const pruned = JSON.parse(win2.localStorage.getItem('ip-please-announce-dismissed-v1'));
  check('只保留仍生效的 ID', pruned.length === 2 && pruned.indexOf('ann_retiredretiredretired00') < 0, pruned);
}

async function testFailureIsQuiet() {
  console.log('→ 拉取失败不打扰');
  const dom = newDom();
  const win = dom.window;
  win.fetch = async () => { throw new Error('offline'); };
  load(dom);
  await wait(60);
  check('横幅保持隐藏', win.document.getElementById('announce').hidden === true);
  check('没有错误提示', win.document.getElementById('toast').textContent === '');
}

async function testAdminSection() {
  console.log('→ 管理员区块');
  // 普通玩家看不到
  const domPlayer = newDom();
  const player = domPlayer.window;
  seedAuth(player, USER);
  player.fetch = async () => makeRes(200, { announcements: [] });
  load(domPlayer);
  await wait(60);
  player.document.getElementById('cloud').click();
  await wait(20);
  check('普通玩家没有公告管理', player.document.getElementById('cloud-panel').textContent.indexOf('公告管理') < 0);

  const dom = newDom();
  const win = dom.window;
  seedAuth(win, Object.assign({}, USER, { is_admin: true }));
  const posts = [];
  let adminList = [ITEMS[0]];
  win.fetch = async (url, options) => {
    const target = String(url);
    const opts = options || {};
    if (target.endsWith('/admin/announcements') && opts.method === 'POST') {
      posts.push({ target, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      return makeRes(201, Object.assign({ announcement_id: 'ann_cccccccccccccccccccccc' }, JSON.parse(opts.body)));
    }
    if (target.indexOf('/retire') >= 0) {
      posts.push({ target, auth: opts.headers.Authorization });
      adminList = [];
      return makeRes(200, ITEMS[0]);
    }
    if (target.endsWith('/admin/announcements')) return makeRes(200, { announcements: adminList });
    return makeRes(200, { announcements: [] });
  };
  load(dom);
  await wait(60);
  win.document.getElementById('cloud').click();
  await wait(60);
  const panel = win.document.getElementById('cloud-panel');
  check('管理员看到公告管理', panel.textContent.indexOf('公告管理') >= 0);
  check('列表里的标题已转义', panel.querySelector('img') === null && panel.innerHTML.indexOf('&lt;img') >= 0);

  win.document.getElementById('ann-title').value = '新活动';
  win.document.getElementById('ann-body').value = '无尽模式排行榜上线';
  win.document.getElementById('ann-level').value = 'info';
  win.document.getElementById('ann-duration').value = '2';
  Array.from(win.document.querySelectorAll('#cloud-panel button')).find((b) => b.dataset.action === 'ann-publish').click();
  await wait(60);
  const publishCall = posts.find((post) => post.body);
  check('发布带管理员 Token', !!publishCall && publishCall.auth === 'Bearer at-1');
  check('发布内容正确', !!publishCall && publishCall.body.title === '新活动' && publishCall.body.level === 'info', publishCall && publishCall.body);
  const days = publishCall ? (Date.parse(publishCall.body.ends_at) - Date.now()) / 86400000 : 0;
  check('有效期 3 天', days > 2.9 && days < 3.01, days);

  await wait(60);
  const retireButton = Array.from(win.document.querySelectorAll('#cloud-panel button')).find((b) => b.dataset.action === 'ann-retire');
  check('列表有下线按钮', !!retireButton);
  if (retireButton) retireButton.click();
  await wait(60);
  const retireCall = posts.find((post) => post.target.indexOf('/retire') >= 0);
  check('下线调用正确地址', !!retireCall && retireCall.target.endsWith('/admin/announcements/ann_aaaaaaaaaaaaaaaaaaaaaa/retire'), retireCall && retireCall.target);
}

(async function main() {
  await testBannerAndDismiss();
  await testFailureIsQuiet();
  await testAdminSection();
  console.log('');
  if (failures.length) {
    console.log('FAILED ' + failures.length + '/' + checks + ': ' + failures.join(', '));
    process.exit(1);
  }
  console.log('ALL ' + checks + ' ANNOUNCE CHECKS PASSED');
  // announce.js 有 15 分钟的定时刷新，jsdom 的定时器会让进程一直挂着
  process.exit(0);
})();
