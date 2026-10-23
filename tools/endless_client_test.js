#!/usr/bin/env node
'use strict';
// 无尽模式前端（endless.js + booth / events 的服务器分支）测试：用假的 CloudSync 模拟服务器。
//
//   node tools/endless_client_test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createRuntime = require('./test_runtime');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log('✓ ' + name); }
const tick = () => new Promise((resolve) => setImmediate(resolve));
// 沙盒里的对象原型不同，深比较前先序列化成本 realm 的值
const J = (run, code) => JSON.parse(run('JSON.stringify(' + code + ')'));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

const ENT = 'ent_' + 'a'.repeat(22);
const RUN = 'run_' + 'b'.repeat(22);
const WAVE = 'wave_' + 'c'.repeat(22);

function passport(extra) {
  return Object.assign({ type: 'passport', key: 'pp', cc: 'US', photo: 'P03', surname: 'MILLER', given: 'JAMES', dob: '1984.03.12', sex: 'M', iss: 'NEW YORK', exp: '2031.07.22' }, extra);
}
const DEVICE = { type: 'device', key: 'dv', ip: '72.14.3.9', loc: '美国 · 纽约', tz: 'Asia/Shanghai', lang: 'en-US', device: 'MacBook', net: 'hosting' };
const ACCOUNT = { type: 'account', key: 'ac', pay: { brand: 'VISA', last4: '1234', virtual: true }, bill: '12 Oak St, NY', phone: '+1 212-555-0123' };
const TRAVELER = {
  entrant_id: ENT, seq: 1, person: 'P03', voice: 140, intro: [['E', 'Hi.', null]], primary: 'pp',
  docs: [passport(), DEVICE, ACCOUNT],
  logins: [{ ago_days: 0, time: '08:21', loc: '美国 · 纽约' }, { ago_days: 1, time: '19:02', loc: '美国 · 纽约' }, { ago_days: 3, time: '13:40', loc: '美国 · 纽约' }],
  xray: ['xr.cat'],
};
const FISH = {
  entrant_id: ENT, seq: 2, person: 'FISH', voice: 165, primary: 'pp',
  intro: [['E', '你好，我是美国 OpenAI 模型。', null], ['C', '请出示证明。', null]],
  docs: [passport({ photo: 'FISH', surname: 'BLUB', given: 'FISHY', sex: 'F' }), Object.assign({}, DEVICE, { net: 'home', tz: 'America/New_York' }),
    { type: 'model_permit', key: 'md', claim: 'OpenAI GPT', model_id: 'deepseek-chat', org: 'DeepSeek' }],
  logins: [], xray: [],
};

function runView(extra) {
  return Object.assign({
    run_id: RUN, mode: 'endless', status: 'active', end_reason: null, score: 0, travelers: 0, processed: 0, correct: 0,
    streak: 0, best_streak: 0, strikes: 0, max_strikes: 3, multiplier: 1, travelers_total: null, next_kind: 'traveler',
    bulletin: { kind: 'device', args: { device: 'MacBook' }, remaining: 3 },
    wanted: { block: 0, photo: 'P07', name: 'KING, MARY', crime: 1, reward: 500 },
  }, extra);
}

// 假服务器：记录请求，按脚本回应
function fakeCloud(script) {
  const calls = [];
  const cloud = {
    calls,
    isLoggedIn: () => true,
    ui: { toast() {}, showDialog(cfg) { cloud.dialog = cfg; }, closeDialog() {}, escapeHtml: (s) => String(s) },
    async api(p, opts) {
      const body = opts && opts.body !== undefined ? JSON.parse(JSON.stringify(opts.body)) : undefined;
      const call = { path: p, method: (opts && opts.method) || 'GET', body };
      calls.push(call);
      const handler = script(call);
      if (handler instanceof Error) throw handler;
      return JSON.parse(JSON.stringify(handler));
    },
  };
  cloud.optionalAuthApi = cloud.api;
  return cloud;
}

function apiError(status, code) {
  const error = new Error(code);
  error.status = status; error.code = code;
  return error;
}

function boot(script) {
  const { run, sandbox } = createRuntime(777);
  const cloud = fakeCloud(script);
  sandbox.CloudSync = cloud;
  run(`
    function advance(seconds) {
      for (let i = 0; i < Math.ceil(seconds * 20); i++) { now += 0.05; if (scene === 'booth') runTimers(); }
    }
    setCtx(document.createElement('canvas').getContext('2d'));
  `);
  return { run, sandbox, cloud };
}

(async function main() {
  await test('server documents build into game documents without any answers', async () => {
    const { run, sandbox } = boot(() => ({}));
    sandbox.__pub = TRAVELER;
    run(`var spec = entrantFromServer(__pub)`);
    assert.equal(run('spec.srv.entrant_id'), ENT);
    assert.deepEqual(J(run, '[spec.ok.length, spec.issues.length, Object.keys(spec.react).length, spec.quiz]'), [0, 0, 0, null]);
    assert.equal(run(`spec.docs.map(d => d.key).join()`), 'pp,dv,ac');
    assert.equal(run(`spec.docs[0].doc.name`), 'MILLER, JAMES');
    assert.equal(run(`spec.docs[0].doc.person`), 'P03');
    assert.equal(run(`spec.docs[0].doc.mrz.slice(0, 5)`), 'P<USA');
    assert.deepEqual(J(run, `spec.docs[1].doc.rows.map(r => r[0])`), ['IP', '归属', '时区', '语言', '设备', '网络']);
    assert.equal(run(`spec.docs[1].doc.rows[5][1]`), '机房 IP（云服务器）');
    assert.equal(run(`spec.docs[2].doc.rows[0][1]`), '虚拟卡 ··1234');
    assert.equal(run(`spec.logins.length`), 3);
    assert.ok(run(`spec.logins[0].startsWith('今天 08:21')`));
    assert.equal(run(`spec.xray[0].key`), 'xr.cat');
    sandbox.__pub = FISH;
    run(`var fish = entrantFromServer(__pub)`);
    assert.equal(run(`fish.logins`), null, 'fish has no login slip');
    assert.equal(run(`fish.xray`), null);
    assert.equal(run(`fish.docs[2].key`), 'md');
    assert.deepEqual(J(run, `fish.intro.map(l => l.length)`), [2, 2], 'null opts are dropped');
  });

  await test('every issue kind the server can send has client text', async () => {
    const { run, sandbox } = boot(() => ({}));
    const generator = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'endless', 'generator.rs'), 'utf8');
    const kinds = new Set([...generator.matchAll(/issue\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    if (/format!\("xray_\{flaw\}"\)/.test(generator)) { kinds.add('xray_cat'); kinds.add('xray_keys'); }
    assert.ok(kinds.size >= 15, 'found issue kinds in generator.rs: ' + [...kinds]);
    const args = { country: '美国', tz: 'Asia/Shanghai', lang: 'zh-CN', loc: '中国 · 北京', phone: '+1 209-555-0101', say: '1', rule: 'device', device: 'MacBook', city: '纽约' };
    for (const kind of kinds) {
      sandbox.__view = { kind, args, fields: ['a.b', 'c.d'] };
      const issue = J(run, `issueFromServer(__view)`);
      assert.ok(issue.title && issue.title !== '信息不符' || kind === 'nationality_ip', `kind ${kind} falls back to generic text`);
      assert.equal(issue.srvKind, kind);
      assert.deepEqual(issue.pairs, [['a.b', 'c.d']]);
    }
  });

  // ———————————————————— 完整流程 ————————————————————

  function flowScript(state) {
    return (call) => {
      if (call.path === '/endless/runs' && call.method === 'POST') return { run: runView(), item: null };
      if (call.path.endsWith('/next')) {
        state.nexts++;
        const item = state.items.shift();
        return { run: runView({ next_kind: item.item_type === 'wave' ? 'wave' : 'traveler' }), item };
      }
      if (call.path.endsWith('/inspect')) {
        state.inspects.push(call.body);
        if (call.body.fields && call.body.fields.includes('dv.网络')) {
          return { match: true, new: true, claims_left: 6, locked: false, issue: { kind: 'hosting', args: {}, fields: call.body.fields } };
        }
        return { match: false, claims_left: 5, locked: false };
      }
      if (call.path.endsWith('/quiz')) return { exposed: true };
      if (call.path.endsWith('/decision')) {
        state.decisions.push(call.body);
        const final = state.finalAfter && state.decisions.length >= state.finalAfter;
        return {
          entrant_id: call.body.entrant_id, decision: call.body.decision, correct: call.body.decision !== 'approve', points: 150,
          breakdown: { base: 100, pointing: 50, exposed: 0, wanted: 0, multiplier: 1, total: 150 },
          reveal: { ok: ['deny', 'detain'], flaws: ['hosting'], issues: [{ kind: 'hosting', args: {}, fields: ['dv.网络', 'rule.net'] }], liar: true, fish: null, wanted: false, bulletin: false },
          citation: call.body.decision === 'approve' ? { kind: 'approved_flawed', reason: { kind: 'hosting', args: {}, fields: ['dv.网络', 'rule.net'] } } : null,
          run: runView({ score: 150, travelers: state.decisions.length, processed: state.decisions.length, correct: 1, streak: 1, best_streak: 1,
            status: final ? 'ended' : 'active', end_reason: final ? 'strikes' : null }),
          final: final ? { run_id: RUN, mode: 'endless', score: 150, travelers: 1, correct: 1, best_streak: 1, end_reason: 'strikes', flagged: false, ranks: { endless: 3, weekly: 1 }, personal_best: 150 } : null,
        };
      }
      if (call.path.includes('/waves/')) {
        state.waves.push(call.body);
        return { wave_id: WAVE, type: 'rush', hits: 5, wrong: 1, missed: 0, points: 100, per_item: [], citation: { kind: 'rush_wrong', count: 1 }, run: runView({ score: 250 }), final: null };
      }
      if (call.path === '/endless/runs/current') return state.current || apiError(404, 'not_found');
      return apiError(500, 'unexpected ' + call.path);
    };
  }

  await test('a traveler round trip: call, inspect, quiz, stamp, return, server verdict', async () => {
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [{ item_type: 'traveler', entrant: TRAVELER, progress: { found: [], quiz: null, claims_left: 6, locked: false } }] };
    const ctx = boot(flowScript(state));
    const { run, sandbox, cloud } = ctx;
    // 开局：大厅里的「无尽模式」按钮走的就是这个接口
    await sandbox.Endless.start('endless');
    await settle();
    assert.equal(run('scene'), 'daycard');
    assert.equal(run('S.endless'), true);
    run(`go('booth')`);
    assert.ok(run(`B.docs.some(d => d.key === 'wt' && d.owner === 'desk')`), 'wanted poster on the desk');
    assert.ok(run(`B.docs.some(d => d.key === 'bul' && d.owner === 'desk')`), 'bulletin on the desk');
    assert.equal(run(`B.docs.find(d => d.key === 'wt').doc.fields.photo.length`), 4);

    run(`callNext()`);
    await settle();
    assert.equal(state.nexts, 1);
    run(`advance(4)`);
    assert.equal(run(`B.ent && B.ent.phase`), 'here');
    assert.ok(run(`B.ent.handed`));
    assert.ok(run(`B.docs.some(d => d.key === 'log')`) || run(`!!B.printing`), 'login slip is printed');
    run(`drawBooth()`);

    // 指认：设备卡「网络」+ 规则书 §8
    run(`toggleRules(); for (const d of B.docs) d.big = false;
      const dv = B.docs.find(d => d.key === 'dv'); Object.assign(dv, { big: true, x: 230, y: 136 });
      B.ruleInst.big = true; Object.assign(B.ruleInst, { x: 420, y: 136 });
      setInspect(true);`);
    run(`{ const dv = B.docs.find(d => d.key === 'dv'); const f = dv.doc.fields['网络'];
      inspectClick(dv.x + (f[0] + f[2]) / 2, dv.y + (f[1] + f[3]) / 2); }`);
    run(`{ const r = B.ruleInst; const f = r.doc.fields['net'] || Object.entries(r.doc.fields).find(([k]) => k === 'net')[1];
      inspectClick(r.x + (f[0] + f[2]) / 2, r.y + (f[1] + f[3]) / 2); }`);
    assert.equal(run(`B.insp.banner.title`), run(`T('对齐部核验中…')`));
    await settle();
    assert.equal(state.inspects.length, 1);
    assert.deepEqual(state.inspects[0].fields.slice().sort(), ['dv.网络', 'rule.net'].sort());
    assert.equal(run(`B.insp.banner.title`), run(`T('机房 IP')`));
    assert.ok(run(`B.ent.suspect`));
    run(`setInspect(false)`);

    // 测谎：服务器说会露馅
    run(`now = Math.max(now, B.ent.busyUntil); boothDown(...center(QUIZ_BTN))`);
    await settle();
    assert.ok(run(`B.ent.exposed`), 'server said the traveler is a liar');

    // 盖「拒绝」章，把护照还回去 → 服务器判定
    run(`advance(6); if (B.ruleInst) toggleRules(); const e = B.ent; for (const d of e.docs) d.big = false;
      const d = primaryOf(e); Object.assign(d, { big: true, x: 440, y: 184 });
      B.tray = { open: true, t: now - 1 };
      boothDown(...center(stampBtnBox('deny', trayX()))); advance(0.2);
      if (!decisionOf(d)) throw Error('stamp missed the passport');
      dragStart(d, d.x + 12, d.y + 12); dragMove(100, 270); dragEnd(100, 270);`);
    assert.equal(run(`B.ent.phase`), 'waiting');
    await settle();
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0].decision, 'deny');
    assert.equal(state.decisions[0].entrant_id, ENT);
    run(`advance(6)`);
    assert.equal(run(`B.ent`), null, 'traveler left');
    assert.equal(run(`B.correct`), 1);
    assert.equal(run(`Endless.run().score`), 150);
    assert.ok(cloud.calls.every((c) => c.path.startsWith('/endless/')), 'only endless endpoints are used');
    run(`drawBooth()`);
  });

  await test('approving a flawed traveler prints the server citation; ending goes to the eover screen', async () => {
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], finalAfter: 1, items: [{ item_type: 'traveler', entrant: FISH, progress: {} }] };
    const ctx = boot(flowScript(state));
    const { run, sandbox } = ctx;
    await sandbox.Endless.start('endless');
    await settle();
    run(`go('booth'); callNext();`);
    await settle();
    run(`advance(8); const e = B.ent; for (const d of e.docs) d.big = false;
      const d = primaryOf(e); Object.assign(d, { big: true, x: 440, y: 184 });
      B.tray = { open: true, t: now - 1 };
      boothDown(...center(stampBtnBox('approve', trayX()))); advance(0.2);
      dragStart(d, d.x + 12, d.y + 12); dragMove(100, 270); dragEnd(100, 270);`);
    await settle();
    run(`advance(5)`);
    assert.ok(run(`B.cites`) >= 1, 'citation printed');
    assert.ok(run(`B.docs.some(d => d.key === 'cit') || !!B.printing || B.printQueue.length > 0`));
    assert.equal(run(`B.ending`), true);
    run(`advance(3)`);
    assert.equal(run(`scene`), 'eover');
    run(`drawEover(3)`);
    assert.equal(run(`Endless.final().ranks.endless`), 3);
  });

  await test('detain sends the decision immediately', async () => {
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [{ item_type: 'traveler', entrant: TRAVELER, progress: {} }] };
    const ctx = boot(flowScript(state));
    const { run, sandbox } = ctx;
    await sandbox.Endless.start('endless');
    await settle();
    run(`go('booth'); callNext();`);
    await settle();
    run(`advance(4); boothDown(...center(DETAIN_BTN))`);
    await settle();
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0].decision, 'detain');
    run(`advance(3)`);
    assert.equal(run(`B.ent`), null);
    assert.equal(run(`B.correct`), 1);
  });

  await test('rush waves use server faces and submit picks with reaction times', async () => {
    const faces = [{ person: 'SLANG1', line: 'yyds' }, { person: 'P02', line: 'Hey there.' }, { person: 'SLANG0', line: '家人们谁懂啊' },
      { person: 'SLANG2', line: '绝绝子' }, { person: 'P05', line: 'Morning.' }, { person: 'SLANG3', line: '老板说今晚必须上线' }];
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [{ item_type: 'wave', wave: { wave_id: WAVE, type: 'rush', lead_ms: 2600, face_ms: 2600, faces } }] };
    const ctx = boot(flowScript(state));
    const { run, sandbox } = ctx;
    await sandbox.Endless.start('endless');
    await settle();
    run(`go('booth'); callNext();`);
    await settle();
    assert.equal(run(`B.event && B.event.type`), 'rush');
    assert.equal(run(`B.event.list[0].line`), 'yyds');
    for (let i = 0; i < faces.length; i++) {
      run(`advance(${i === 0 ? 3.0 : 0.8}); rushPick('${i % 3 === 1 ? 'approve' : 'deny'}')`);
    }
    run(`advance(2)`);
    await settle();
    assert.equal(state.waves.length, 1);
    const picks = state.waves[0].picks;
    assert.equal(picks.length, 6);
    assert.ok(picks.every((p) => p.rt_ms >= 120 && p.rt_ms <= 2700), JSON.stringify(picks));
    assert.equal(run(`B.event`), null);
    assert.ok(run(`B.cites`) >= 1, 'server citation for wrong picks');
  });

  await test('clone waves use server runners and submit hits with timestamps', async () => {
    const clones = Array.from({ length: 10 }, (_, i) => ({ ts_ms: 1600 + i * 600, x0: 226 + (i % 3) * 20, y: 104 + (i * 7) % 18, v: 40 }));
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [{ item_type: 'wave', wave: { wave_id: WAVE, type: 'clones', gate_x: 356, clones } }] };
    const ctx = boot(flowScript(state));
    const { run, sandbox } = ctx;
    await sandbox.Endless.start('endless');
    await settle();
    run(`go('booth'); callNext();`);
    await settle();
    assert.equal(run(`B.event && B.event.type`), 'clones');
    run(`advance(2.0); updateClones(); { const c = B.event.items[0]; const p = clonePos(c); shootAt(p[0], p[1] - 6); }`);
    for (let i = 0; i < 40; i++) run(`advance(0.5); if (B.event && B.event.type === 'clones') updateClones();`);
    await settle();
    assert.equal(state.waves.length, 1);
    assert.equal(state.waves[0].hits.length, 1);
    assert.equal(state.waves[0].hits[0].i, 0);
    assert.ok(state.waves[0].hits[0].t_ms >= 1600, JSON.stringify(state.waves[0].hits));
  });

  await test('resuming after a reload restores the pending traveler and its findings', async () => {
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [],
      current: { run: runView({ travelers: 4, score: 420 }), item: { item_type: 'traveler', entrant: TRAVELER,
        progress: { found: [{ kind: 'hosting', args: {}, fields: ['dv.网络', 'rule.net'] }], quiz: true, claims_left: 6, locked: false } } } };
    const ctx = boot(flowScript(state));
    const { run, sandbox } = ctx;
    await sandbox.Endless.resume();
    await settle();
    run(`go('booth'); advance(1)`);
    assert.equal(run(`B.ent && B.ent.spec.srv.entrant_id`), ENT);
    assert.ok(run(`B.ent.suspect && B.ent.exposed`));
    assert.equal(state.nexts, 0, 'no new traveler requested');
  });

  await test('a conflict resynchronises from the server', async () => {
    let conflicted = false;
    const state = { nexts: 0, inspects: [], decisions: [], waves: [], items: [{ item_type: 'traveler', entrant: TRAVELER, progress: {} }],
      current: { run: runView(), item: { item_type: 'traveler', entrant: TRAVELER, progress: {} } } };
    const base = flowScript(state);
    const ctx = boot((call) => {
      if (call.path.endsWith('/decision') && !conflicted) { conflicted = true; return apiError(409, 'endless_state_conflict'); }
      return base(call);
    });
    const { run, sandbox, cloud } = ctx;
    await sandbox.Endless.start('endless');
    await settle();
    run(`go('booth'); callNext();`);
    await settle();
    run(`advance(4); boothDown(...center(DETAIN_BTN)); advance(3)`);
    await settle();
    assert.ok(cloud.calls.some((c) => c.path === '/endless/runs/current'), 'asked the server for the current run');
    assert.equal(run(`scene`), 'daycard', 're-entered the run');
  });

  console.log(`\nendless client: ${tests} tests passed.`);
})().catch((error) => { console.error(error); process.exit(1); });
