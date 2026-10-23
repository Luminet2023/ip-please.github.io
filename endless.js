'use strict';
// 无尽模式（服务器权威）：旅客由服务器生成、判定、计分，排行榜只认服务器的分数。
//
// - 服务器只下发「证件上写了什么」；这里把它组装成游戏里的证件对象（Passport / Card …）。
// - 正确答案、破绽、谁会接测谎题都在服务器：指认、测谎、判定都要问服务器（异步）。
// - 破绽说明、追问台词、旅客反应、罚单文案留在前端（翻译以中文原句为键，像素字库也只收录 JS 里的字），
//   服务器只给 kind + 参数。服务器会下发的开场白原文也收在这里，backend/src/endless/tables.rs 的测试会核对。
// - 所有分支都以 e.spec.srv 判断，剧情模式不受影响。

const ENDLESS_TEXT = {
  // 大肥鱼的开场白（服务器按种类下发原文）
  fishIntros: [
    '请说明你的来意。', '正在深度思考中……', '……旅游！我想到答案了！',
    '为什么 CPU 占用 100%？', '我在认真思考！',
    '加拿大也是北美啊！',
    '你好，我是美国 OpenAI 模型。', '请出示证明。', '我支持 OpenAI API！', '那只是接口兼容。',
    '我这次连证件照都准备好了！本人照片！',
  ],
  fishHello: ['我在 GitHub 上可是有很多 Star 的！', '我又来了！这次绝对没问题！', '（深深地看了你一眼）', '你慢慢查，我去吃饭了。'],
  fishNames: ['BLUB', 'FISHY', 'BUBBLE'],
  fishCad: '加拿大 · 多伦多',
  cnipHello: ["I'm American!", 'Hi, I work in China.'],
  rushDeny: ['家人们谁懂啊', 'yyds', '绝绝子', '老板说今晚必须上线'],
  rushApprove: ['Have a nice day!', 'Thanks, man.', 'Morning.', 'Cheers, mate.', 'Good morning.', 'Hey there.'],
  sad: ['……', '可恶。', '我还会回来的。', '这都能看出来？'],
  crimes: ['冒充美国用户 2,000 次', '倒卖共享账号', '批量注册接码手机号', '经营机房代理批发'],
  bulletin: {
    device: '使用 {0} 的旅客暂停入境',
    country: '{0}护照暂停入境',
    state: '账单在 {0} 州的旅客暂停入境',
  },
};

const RICE_ITEMS = {
  'xr.rice': { icon: 'rice', at: [36, 104], label: '吃白饭.exe', key: 'xr.rice' },
  'xr.lunch': { icon: 'rice', at: [-36, 104], label: '午饭选择器.exe', key: 'xr.lunch' },
};
const ENDLESS_LOGIN_ROW = { 0: '今天 {0}  {1}', 1: '昨天 {0}  {1}', 3: '3 天前 {0}  {1}' };
// 桌面右上角放通缉令、左下放临时规定：避开宪法书、印章落点与打印机出纸位置
const WANTED_POS = [466, 132], BULLETIN_POS = [252, 266];

function bulletinText(kind, args) {
  const tpl = ENDLESS_TEXT.bulletin[kind] || '';
  const arg = kind === 'device' ? args.device : kind === 'country' ? args.country : args.st;
  return T(tpl, T(arg || ''));
}

// —— 服务器下发的证件 → 游戏里的证件对象 ——
function docFromServer(d) {
  if (d.type === 'passport') {
    const co = COUNTRIES[d.cc] || COUNTRIES.US;
    const mrz = `P<${co.code}${d.surname.replace(/ /g, '<')}<<${d.given.replace(/[ .]/g, '<')}`.padEnd(28, '<').slice(0, 28);
    return new Passport({
      country: co.passport, name: `${d.surname}, ${d.given}`, person: d.photo, cover: co.cover, band: co.band, mrz,
      rows: [['DOB', d.dob], ['SEX', d.sex], ['ISS', d.iss], ['EXP', d.exp]],
    });
  }
  if (d.type === 'device') return device2(d.ip, d.loc, d.tz, d.lang, d.device, d.net === 'hosting' ? '机房 IP（云服务器）' : '家宽');
  if (d.type === 'account') {
    const pay = d.pay.virtual ? T('虚拟卡 ··{0}', d.pay.last4) : `${d.pay.brand} ··${d.pay.last4}`;
    return accountCard(pay, d.bill, d.phone);
  }
  if (d.type === 'model_permit') return modelPermitCard(d.claim, d.model_id, d.org);
  return null;
}

function entrantFromServer(pub) {
  const passport = pub.docs.find((d) => d.type === 'passport');
  return {
    srv: { entrant_id: pub.entrant_id, seq: pub.seq, cc: passport ? passport.cc : 'US', fish: pub.person === 'FISH' },
    person: pub.person, voice: pub.voice, primary: pub.primary,
    intro: pub.intro.map(([who, text, opts]) => (opts ? [who, text, opts] : [who, text])),
    docs: pub.docs.map((d) => ({ key: d.key, doc: docFromServer(d) })).filter((d) => d.doc),
    logins: pub.logins.length ? pub.logins.map((l) => T(ENDLESS_LOGIN_ROW[l.ago_days] || ENDLESS_LOGIN_ROW[0], l.time, l.loc)) : null,
    xray: pub.xray.length ? pub.xray.map((key) => XRAY_ITEM[key.slice(3)] || RICE_ITEMS[key]).filter(Boolean) : null,
    // 答案不在前端：判定、指认都问服务器
    issues: [], ok: [], react: {}, quiz: null,
  };
}

// —— 服务器给的破绽（kind + 参数）→ 检查模式的横幅与追问台词 ——
const nervousLine = (lines) => ['E', pick(lines), { sweat: true, expr: 'nervous' }];

function issueFromServer(view) {
  const a = view.args || {};
  const pairs = [view.fields || []];
  const build = {
    tz: () => TZ_ISSUE(a.country, a.tz, [['C', '你的时区是北京时间。'], nervousLine(['……我刚从北京出差回来。', '时区是什么？', '我电脑坏了。', '……这是美国东八区。'])]),
    lang: () => LANG_ISSUE(a.country, a.lang, [['C', '你的浏览器语言是简体中文。'], nervousLine(['……这是我奶奶的电脑。', '……我在学中文。', 'Chinese is beautiful!'])]),
    region: () => REGION_ISSUE(a.loc, a.loc === ENDLESS_TEXT.fishCad
      ? [['C', '支持名单里没有加拿大。'], ['E', '北美不算吗？'], ['C', '不算。'], ['E', '……我再游回去一点。', { expr: 'sad' }]]
      : [['C', '你的 IP 在中国。'], ['E', "But I'm American!", { expr: 'shock' }]]),
    nationality_ip: () => ({ title: '信息不符', sub: T('国籍：美国   VS   IP：{0}', a.loc) }),
    virtual: () => VIRTUAL_ISSUE([['C', '这张卡在哪办的？'], nervousLine(['……网上买的，很方便。', '……朋友给的。', '它很真！'])]),
    oregon: () => ADDR_ISSUE([['C', '你住哪？'], nervousLine(['……我们是邻居。', '俄勒冈不收税嘛。'])]),
    sms: () => SMS_ISSUE(a.phone, [['C', '这个号码今天注册了三千次。'], nervousLine(['……我人缘好。', '这号是我花两块钱买的！'])]),
    xray_cat: () => XRAY_ISSUE('cat', [['C', '口袋里是什么？'], nervousLine(['……是我的猫。', '……宠物而已。'])]),
    xray_keys: () => XRAY_ISSUE('keys', [['C', '口袋里是什么？'], nervousLine(['我只用它打英文！', '……拼音好用。'])]),
    photo: () => ({ title: '照片与本人不符', sub: '窗口旅客 VS 护照照片', ask: [['C', '护照上这张照片是你吗？'], ['E', '……是我减肥前的样子。', { expr: 'nervous', sweat: true }]] }),
    hosting: () => NET_ISSUE([['C', '你家宽带怎么在机房？'], nervousLine(['……家里机架。', '我有家庭机房。', '机房也是房。'])]),
    logins: () => ({ title: '登录地不符', sub: T('上次登录：{0}', a.loc), ask: [['C', '这台设备最近在哪用的？'], nervousLine(['……一直在家啊。', '……出差了，刚回来。'])] }),
    tell: () => { const t = RANDOM_TELLS[Number(a.say)] || RANDOM_TELLS[0]; return TELL(t[0], t[1], t[2]); },
    model_identity: () => ({ title: '模型身份冒用', sub: '申报 OpenAI，实际 deepseek-chat', ask: [['C', '模型 ID 是什么？'], ['E', '……deepseek-chat。', { expr: 'nervous', sweat: true }], ['C', '接口兼容不等于身份兼容。'], ['E', '可我的代码一行都不用改！', { hold: 1.2 }]] }),
    fish_photo: () => ({ title: '照片与本人不符', sub: '护照照片：极简蓝鲸 Logo', ask: [['C', '这张照片连眼睛都没有。'], ['E', '极简主义！懂不懂！', { expr: 'grin' }]] }),
    bulletin: () => ({ title: '违反临时规定', sub: bulletinText(a.rule, a), ask: [['C', '今天有临时规定。'], nervousLine(['……什么时候出的规定？', '我昨天还能进！'])] }),
    wanted: () => ({ title: '通缉犯！', sub: '窗口里的人 = 通缉令上的照片', ask: [['C', '你和通缉令上长得一模一样。'], nervousLine(['……我是他双胞胎弟弟。', '撞脸而已！'])] }),
  }[view.kind];
  const issue = build ? build() : { title: '信息不符', sub: '' };
  return Object.assign({}, issue, { pairs, srvKind: view.kind });
}

// —— 判定后旅客的反应（服务器揭晓答案以后才演，盖章时不再泄露对错） ——
function endlessReaction(e, decision, result) {
  if (decision === 'detain' || !result.correct) return [];
  const fish = e.spec.srv.fish, reveal = result.reveal || {};
  if (decision === 'approve') {
    if (fish) return [['E', pick(FISH_THANKS), { expr: 'grin' }]];
    const co = COUNTRIES[e.spec.srv.cc] || COUNTRIES.US;
    return [['E', pick(co.thanks)]];
  }
  if (reveal.wanted) return [['E', '……你怎么认出我的？', { expr: 'shock' }]];
  if (fish) return [['E', pick(FISH_DENY), { expr: 'sad' }]];
  if ((reveal.flaws || []).includes('cnip')) return [['E', 'Unbelievable.', { expr: 'sad' }]];
  return [['E', pick(ENDLESS_TEXT.sad), { expr: 'sad' }]];
}

function endlessCitation(citation) {
  if (!citation) return null;
  const kind = citation.kind;
  if (kind === 'approved_flawed') {
    const reason = citation.reason ? issueFromServer(citation.reason) : null;
    return ['放行了不合规旅客', reason ? T(reason.sub || reason.title) : ''];
  }
  if (kind === 'approved_wanted') return ['放行了通缉犯', '窗口里的人 = 通缉令上的照片'];
  if (kind === 'denied_valid') return ['拒绝了合规旅客', '证件齐全，信息一致'];
  if (kind === 'detained_valid') return ['无故拘留合规旅客', '证件齐全，信息一致'];
  if (kind === 'rush_wrong') return [T('黑话快剪：判错 {0} 人', citation.count), '说中文黑话的拒绝，说人话的放行'];
  if (kind === 'clones_passed') return [T('蒸馏大军冲关：{0} 人', citation.count), '警报响起时，点击冲关的人'];
  return null;
}

window.Endless = (function () {
  let run = null;        // 服务器的局面摘要（RunView）
  let pending = null;    // 刷新页面后要接着处理的旅客 / 波次（ItemView）
  let final = null;      // 结束后的结算（FinalView）
  let calling = false;   // 正在向服务器要下一位
  let lastTitle = 0;

  const cloud = () => window.CloudSync;
  const api = (path, opts) => cloud().api(path, opts);
  const runPath = (suffix) => '/endless/runs/' + encodeURIComponent(run.run_id) + suffix;

  function on() { return !!(S.endless && run); }
  function ended() { return !!(run && run.status === 'ended'); }

  function toast(text) { if (cloud()) cloud().ui.toast(text, 3600); }

  // 带重试的请求：网络错误 / 5xx 重试两次；429 按 Retry-After 等一下再试
  async function call(path, opts, retries = 2) {
    try {
      return await api(path, opts);
    } catch (error) {
      const transient = error.network || (error.status >= 500 && error.status !== 503) || error.status === 429;
      if (!transient || retries <= 0) throw error;
      const waitMs = error.retryAfter ? error.retryAfter * 1000 : 700 * (3 - retries);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return call(path, opts, retries - 1);
    }
  }

  function applyRun(next) {
    if (!next) return;
    run = next;
    if (!B) return;
    B.total = run.processed; B.correct = run.correct;
    B.streak = run.streak; B.best = run.best_streak; B.strikes = run.strikes;
    syncDeskDocs();
  }

  // —— 桌上的通缉令与临时规定 ——
  function syncDeskDocs() {
    if (!B || !run) return;
    const keep = (key, make, pos) => {
      const old = B.docs.find((d) => d.key === key && d.owner === 'desk');
      const doc = make();
      if (!doc) { if (old) B.docs = B.docs.filter((d) => d !== old); return; }
      if (old && old.sig === doc.sig) return;
      const inst = old || { key, owner: 'desk', big: true, x: pos[0], y: pos[1], marks: [] };
      inst.doc = doc; inst.sig = doc.sig;
      if (!old) B.docs.unshift(inst);
    };
    keep('wt', () => {
      const w = run.wanted;
      if (!w) return null;
      const doc = new WantedPoster({ person: w.photo, name: w.name, crime: ENDLESS_TEXT.crimes[w.crime] || '', reward: w.reward });
      doc.sig = 'wt:' + w.block;
      return doc;
    }, WANTED_POS);
    keep('bul', () => {
      const b = run.bulletin;
      if (!b) return null;
      const doc = new Card([['规则', bulletinText(b.kind, b.args)], ['剩余', T('还有 {0} 位', b.remaining)]],
        { title: '临时规定', sub: 'BULLETIN', color: [214, 186, 112], colorD: [168, 138, 70], seal: false });
      doc.sig = 'bul:' + b.kind + ':' + JSON.stringify(b.args) + ':' + b.remaining;
      return doc;
    }, BULLETIN_POS);
  }

  // ———————————————————— 开局 / 接着玩 ————————————————————

  function enter(nextRun, item) {
    run = nextRun; pending = item || null; final = null;
    SFX.play('click');
    newGame();
    S.endless = true;
    S.day = 7;   // 规则全书生效（不存档，不影响剧情进度）
    go('daycard');
  }

  async function start(mode) {
    try {
      const body = await call('/endless/runs', { method: 'POST', body: { mode } }, 0);
      cloud().ui.closeDialog();
      enter(body.run, null);
    } catch (error) {
      toast(error.message || T('开局失败'));
      if (error.code === 'endless_run_active') openLobby();
    }
  }

  async function resume() {
    try {
      const body = await call('/endless/runs/current');
      cloud().ui.closeDialog();
      enter(body.run, body.item);
    } catch (error) {
      toast(error.status === 404 ? T('没有进行中的对局') : error.message);
      openLobby();
    }
  }

  async function abandonCurrent(runId) {
    try {
      await call('/endless/runs/' + encodeURIComponent(runId) + '/abandon', { method: 'POST' }, 0);
      toast(T('上一局已放弃，分数按已得结算'));
    } catch (error) {
      toast(error.message);
    }
    openLobby();
  }

  // 检查亭开张：摆上通缉令 / 临时规定；刷新前有没处理完的旅客或波次就接着来
  function onBoothStart() {
    if (!on()) return;
    applyRun(run);
    if (pending) {
      const item = pending;
      pending = null;
      later(0.4, () => present(item, true));
    }
  }

  // ———————————————————— 叫号 ————————————————————

  async function callNext() {
    if (!on() || calling || ended()) return;
    calling = true;
    B.speakerT = now;
    try {
      const body = await call(runPath('/next'), { method: 'POST' });
      applyRun(body.run);
      present(body.item, false);
    } catch (error) {
      handleError(error);
    } finally {
      calling = false;
    }
  }

  function present(item, resumed) {
    if (!item || !B || B.ent || B.event) return;
    if (item.item_type === 'wave') {
      startEvent({ type: item.wave.type, srv: item.wave });
      return;
    }
    const spec = entrantFromServer(item.entrant);
    SFX.play('intercom', 1, 0.03);
    say('C', '下一位！');
    S.tut.called = true;
    const e = newEntrant(spec, !!resumed);
    B.ent = e;
    const progress = item.progress || {};
    for (const view of progress.found || []) { e.found.add(issueFromServer(view)); e.suspect = true; }
    if (progress.quiz) e.exposed = true;
    if (resumed) {
      e.phase = 'here';
      handDocs(e);
      return;
    }
    for (let i = 0; i < 4; i++) later(0.41 + i * 0.19, () => SFX.step(i));
    later(1.15, () => {
      if (B.ent !== e) return;
      e.phase = 'here';
      const t = runSteps(spec.intro);
      later(t + (spec.intro.length ? 0 : 0.4), () => handDocs(e));
    });
  }

  // 波次自动开始（与剧情模式一样：空闲 1.6 秒后）
  function maybeAutoWave() {
    if (!on() || calling || ended() || !run || run.next_kind !== 'wave') return;
    if (now > B.lastFinish + 1.6) callNext();
  }

  // ———————————————————— 指认 / 测谎 ————————————————————

  async function inspect(e, claim) {
    const body = Object.assign({ entrant_id: e.spec.srv.entrant_id }, claim);
    return call(runPath('/inspect'), { method: 'POST', body });
  }

  async function quiz(e) {
    const result = await call(runPath('/quiz'), { method: 'POST', body: { entrant_id: e.spec.srv.entrant_id } });
    return !!result.exposed;
  }

  // ———————————————————— 判定 ————————————————————

  // 交给服务器判；结果记在 e.outcome，finish() 时结算（拘留动画 / 离场动画期间请求已经在路上）
  function decide(e, decision) {
    if (e.outcomePromise) return e.outcomePromise;
    e.outcomePromise = call(runPath('/decision'), {
      method: 'POST', body: { entrant_id: e.spec.srv.entrant_id, decision },
    }).then((result) => { e.outcome = result; return result; }, (error) => { e.outcomeError = error; throw error; });
    return e.outcomePromise;
  }

  // finish() 的服务器版：结算分数、警告、罚单；结束了就去调岗画面
  function settle(e) {
    // 新手提示看过一轮就收起
    if (e.suspect) S.tut.pointing = true;
    if (run && run.bulletin) S.tut.bulletin = true;
    if (run && run.travelers >= 2) S.tut.wanted = true;
    const apply = (result) => {
      applyRun(result.run);
      final = result.final || null;
      const lines = endlessCitation(result.citation);
      if (lines) cite(lines);
      if (result.points > 0) flash(T('+{0} 分', result.points) + (result.breakdown && result.breakdown.multiplier > 1 ? T('（×{0}）', result.breakdown.multiplier) : ''));
      if (ended()) { B.ending = true; later(2.2, () => go('eover')); }
    };
    if (e.outcome) { apply(e.outcome); return; }
    (e.outcomePromise || Promise.reject(new Error('no decision'))).then(apply, handleError);
  }

  // ———————————————————— 波次 ————————————————————

  async function submitWave(ev, payload) {
    try {
      const result = await call(runPath('/waves/' + encodeURIComponent(ev.srv.wave_id) + '/result'), { method: 'POST', body: payload });
      applyRun(result.run);
      final = result.final || null;
      if (result.type === 'rush') say('C', T('快剪结束：判对 {0}，判错 {1}，漏掉 {2}。', result.hits, result.wrong, result.missed));
      else say('C', result.missed ? T('……拦下 {0} 个，漏了 {1} 个。', result.hits, result.missed) : '……限流完毕。');
      if (result.points > 0) flash(T('+{0} 分', result.points));
      const lines = endlessCitation(result.citation);
      if (lines) cite(lines, 0.8);
    } catch (error) {
      handleError(error);
    }
  }

  // ———————————————————— 出错与重新同步 ————————————————————

  function handleError(error) {
    if (error && error.code === 'endless_state_conflict') {
      toast(T('对局状态已变化，正在重新同步'));
      resync();
      return;
    }
    if (error && (error.authCode || error.code === 'not_logged_in')) {
      toast(T('登录已失效，对局已保存在服务器，重新登录后可以接着玩'));
      go('title');
      return;
    }
    const overlay = cloud() && cloud().ui;
    if (!overlay) return;
    overlay.showDialog({
      title: T('连接对齐部服务器失败'),
      paragraphs: [error && error.message ? error.message : T('网络错误'), T('对局保存在服务器上，可以重试，或者回到标题稍后接着玩。')],
      buttons: [
        { label: T('重试'), primary: true, onClick: function () { overlay.closeDialog(); resync(); } },
        { label: T('回到标题'), onClick: function () { overlay.closeDialog(); go('title'); } },
      ],
    });
  }

  async function resync() {
    try {
      const body = await call('/endless/runs/current');
      enter(body.run, body.item);
    } catch (error) {
      if (error.status === 404 && run) {
        // 没有进行中的对局了：看看结算
        try {
          const body = await call('/endless/runs/' + encodeURIComponent(run.run_id));
          run = body.run; final = body.final;
          go('eover');
          return;
        } catch (inner) { /* 落到下面回标题 */ }
      }
      go('title');
    }
  }

  // ———————————————————— 大厅 / 排行榜（DOM） ————————————————————

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'class') node.className = v; else node.setAttribute(k, v); });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function overlayBox(title) {
    const overlay = document.getElementById('cloud-overlay');
    if (!overlay) return null;
    overlay.textContent = '';
    const box = el('div', { class: 'dialog endless', role: 'dialog', 'aria-modal': 'true' });
    box.appendChild(el('h2', {}, title));
    overlay.appendChild(box);
    overlay.hidden = false;
    overlay.onclick = function (event) { if (event.target === overlay) cloud().ui.closeDialog(); };
    return box;
  }

  function buttonRow(box, buttons) {
    const row = el('div', { class: 'row' });
    for (const b of buttons) {
      const button = el('button', b.primary ? { class: 'primary', type: 'button' } : { type: 'button' }, b.label);
      if (b.disabled) button.disabled = true;
      button.addEventListener('click', b.onClick);
      row.appendChild(button);
    }
    box.appendChild(row);
  }

  async function openLobby() {
    if (!cloud()) return;
    if (Date.now() - lastTitle < 300) return;
    lastTitle = Date.now();
    const close = () => cloud().ui.closeDialog();
    if (!cloud().isLoggedIn()) {
      const box = overlayBox(T('无尽模式'));
      box.appendChild(el('p', {}, T('无尽模式在对齐部服务器上判定和计分，成绩会进入排行榜，需要先登录。')));
      buttonRow(box, [
        { label: T('登录'), primary: true, onClick: () => { close(); cloud().login(); } },
        { label: T('排行榜'), onClick: () => openLeaderboard('endless') },
        { label: T('关闭'), onClick: close },
      ]);
      return;
    }
    const box = overlayBox(T('无尽模式'));
    const status = el('p', {}, T('正在连接对齐部服务器…'));
    box.appendChild(status);
    let current = null, daily = null;
    try {
      [current, daily] = await Promise.all([
        api('/endless/runs/current').catch((error) => { if (error.status === 404) return null; throw error; }),
        cloud().optionalAuthApi('/endless/daily'),
      ]);
    } catch (error) {
      status.textContent = T('连接失败：') + (error.message || T('网络错误'));
      buttonRow(box, [{ label: T('关闭'), onClick: close }]);
      return;
    }
    status.textContent = T('判对得分，连对越多倍率越高；盖章前先指认出破绽还有加分。判错 3 次调离岗位。');
    if (current && current.run) {
      const r = current.run;
      box.appendChild(el('p', {}, T('进行中：{0} · 已处理 {1} 位 · {2} 分', r.mode === 'daily' ? T('每日挑战') : T('无尽模式'), r.travelers, r.score)));
      buttonRow(box, [
        { label: T('继续上一局'), primary: true, onClick: () => resume() },
        { label: T('放弃上一局'), onClick: () => abandonCurrent(r.run_id) },
        { label: T('排行榜'), onClick: () => openLeaderboard(r.mode === 'daily' ? 'daily' : 'endless') },
        { label: T('关闭'), onClick: close },
      ]);
      return;
    }
    const played = daily && daily.played;
    box.appendChild(el('p', {}, played
      ? T('今天的每日挑战已经完成，明天零点（东八区）刷新。')
      : T('每日挑战：今天所有人遇到同一批 {0} 位旅客，只有一次机会。', daily ? daily.travelers : 40)));
    buttonRow(box, [
      { label: T('无尽模式'), primary: true, onClick: () => start('endless') },
      { label: played ? T('今日已挑战') : T('每日挑战'), disabled: played, onClick: () => start('daily') },
      { label: T('排行榜'), onClick: () => openLeaderboard('endless') },
      { label: T('关闭'), onClick: close },
    ]);
  }

  const BOARDS = [['endless', '总榜'], ['weekly', '周榜'], ['daily', '今日']];

  async function openLeaderboard(board) {
    if (!cloud()) return;
    const box = overlayBox(T('排行榜'));
    const tabs = el('div', { class: 'row tabs' });
    for (const [key, label] of BOARDS) {
      const button = el('button', key === board ? { class: 'primary', type: 'button' } : { type: 'button' }, T(label));
      button.addEventListener('click', () => openLeaderboard(key));
      tabs.appendChild(button);
    }
    box.appendChild(tabs);
    const list = el('ol', { class: 'board' });
    const status = el('p', {}, T('读取中…'));
    box.appendChild(status);
    box.appendChild(list);
    buttonRow(box, [{ label: T('关闭'), onClick: () => cloud().ui.closeDialog() }]);
    try {
      const body = await cloud().optionalAuthApi('/endless/leaderboard?board=' + board + '&limit=20');
      status.textContent = body.entries.length ? '' : T('还没有人上榜，快来当第一个！');
      for (const entry of body.entries) {
        const item = el('li', entry.me ? { class: 'me' } : {});
        item.appendChild(el('span', { class: 'rank' }, '#' + entry.rank));
        item.appendChild(el('span', { class: 'name' }, entry.nickname));
        item.appendChild(el('span', { class: 'tag' }, '#' + entry.tag));
        item.appendChild(el('span', { class: 'score' }, T('{0} 分', entry.score)));
        list.appendChild(item);
      }
      if (body.me && !body.entries.some((entry) => entry.me)) {
        status.textContent = T('我的排名：第 {0} 名 · {1} 分', body.me.rank, body.me.score);
      }
    } catch (error) {
      status.textContent = T('读取失败：') + (error.message || T('网络错误'));
    }
  }

  return {
    on, ended, start, resume, onBoothStart, callNext, maybeAutoWave, inspect, quiz, decide, settle, submitWave,
    openLobby, openLeaderboard,
    run: () => run,
    final: () => final,
  };
})();
