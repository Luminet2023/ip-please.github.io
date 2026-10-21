#!/usr/bin/env node
'use strict';
const { run } = require('./test_runtime')();
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } };

// ———————————————— 1. 14 天脚本能生成队列 ————————————————
console.log('· 检查 14 天队列');
run('chooseLang("zh")');
for (let day = 1; day <= 14; day++) {
  run(`newGame(); S.day = ${day};`);
  const len = run(`buildQueue(${day}).length`);
  ok(len >= 4 && len <= 9, `DAY ${day} 队列长度 ${len}（应在 4—9）`);
  const items = run(`buildQueue(${day}).map(f => typeof f === 'function' ? (f().caseId || (f().type || 'random')) : (f.type || 'event'))`);
  console.log(`  DAY ${day}: ${len} 人  [${items.join(', ')}]`);
}

// ———————————————— 2. 全流程跑一遍（每天每种裁定都试） ————————————————
console.log('· 跑完整流程');
const decs = ['approve', 'deny', 'detain'];
let cases = 0;
for (let day = 1; day <= 14; day++) {
  for (const dec of decs) {
    run(`newGame(); S.day = ${day}; startDay();`);
    const n = run('B.queue.length');
    for (let i = 0; i < n; i++) {
      const kind = run('typeof B.queue[B.idx]');
      if (kind === 'undefined') break;
      const isEvent = run('isEvent(nextItem())');
      if (isEvent) { run('B.idx++'); continue; }
      try {
        run(`(() => {
          const item = B.queue[B.idx++];
          const spec = typeof item === 'function' ? item() : item;
          const e = newEntrant(spec, true);
          B.ent = e;
          handDocs(e);
          judge(e, '${dec}');
          // 证据单：立刻处理掉，避免卡住
          let guard = 0;
          while (B.evidence && guard++ < 6) evidChoose(['retained','submitted','destroyed'][guard % 3]);
          checkEndDayGate();
        })()`);
        cases++;
      } catch (e) {
        fails++;
        console.error(`  ✗ DAY ${day} 第 ${i + 1} 位 / ${dec}：`, e.message);
      }
    }
    run('B.evidenceQueue = []; if (B.evidence) B.evidence = null;');
  }
}
console.log(`  共跑了 ${cases} 次裁定`);

// ———————————————— 3. 结局：30 个都有定义，且都能被某条路径触发 ————————————————
console.log('· 检查 30 个结局');
const ids = run('Object.keys(ENDINGS)');
ok(ids.length === 30, `结局数量 ${ids.length}`);
for (const id of ids) {
  ok(run(`!!(ENDINGS['${id}'].title && ENDINGS['${id}'].lines.length)`), `${id} 缺少标题或演出文本`);
}

// 终局文书：把状态拉满，看能生成哪些纸
run(`(() => { newGame(); S.day = 14; S.savings = 200; S.flags.bribed = false;
  const p = ensurePlot();
  p.evidence.zeroTicket='retained'; p.evidence.glmSign='retained'; p.evidence.oldRule='retained';
  p.evidence.auditLog='retained'; p.evidence.purgeOrder='retained';
  p.law.contradiction=true; p.law.amended=true; p.law.appealWins=2;
  p.media.footageVerified=true; p.media.report='redacted_ready';
  p.network.mission='glm_control';
  p.fish.licensed=true; p.fish.trust=3; p.seen.fishLegal=true; p.fish.memory='lost';
  p.evidence.fishBackup='retained';
  p.gpt.revoked=true; p.gpt.purgeKnown=true; p.gpt.transfer='pending'; p.relation.gpt=2;
  p.zero.verified=true; p.zero.resetKey=true;
  localStorage.setItem('ip-please-endings-v1', '["E27"]'); })()`);
const papers = run('finalPapers().map(x => x.ending)');
console.log('  可用终局文书（真相全开）：', papers.join(' '));
const fromPapers = new Set(papers);
// 第二条路线：地下组织路线 + 受贿 + 只公开不改革
run(`(() => { newGame(); S.day = 14; S.savings = 200; S.flags.bribed = true;
  const p = ensurePlot();
  p.network.mission='open'; p.network.contact='active';
  p.media.report='redacted_ready'; p.media.footageVerified=true;
  p.gpt.transfer='signed'; p.audit.status='under_watch'; })()`);
const papers2 = run('finalPapers().map(x => x.ending)');
console.log('  可用终局文书（组织路线）：', papers2.join(' '));
for (const id of papers2) fromPapers.add(id);
// 提前/特定动作结局：代码里直接 commitEnding 的那些
const early = new Set(['E01', 'E02', 'E04', 'E08', 'E09', 'E12', 'E14', 'E17', 'E21', 'E22', 'E23', 'E25', 'E26', 'E27', 'E28']);
const missing = ids.filter((id) => !fromPapers.has(id) && !early.has(id));
ok(missing.length === 0, `没有触发路径的结局：${missing.join(', ')}`);

// ———————————————— 3b. 渲染不报错 ————————————————
console.log('· 渲染冒烟');
for (let day = 1; day <= 14; day++) {
  try {
    run(`(() => {
      setCtx(document.createElement('canvas').getContext('2d'));
      newGame(); S.day = ${day}; startDay();
      const it = B.queue.find(x => typeof x === 'function');
      const one = it ? it() : buildQueue(${day})[0];
      B.ent = newEntrant(one, true); handDocs(B.ent);
      drawBooth();
      drawHint();
      setInspect(true); composeInspect(document.createElement('canvas').getContext('2d')); setInspect(false);
      setTray(true); drawTray(); drawDesk(); drawBoothLower();
      drawXray(B.ent, 101);
      drawWindow();
    })()`);
  } catch (e) {
    fails++;
    console.error(`  ✗ DAY ${day} 渲染：`, e.message);
  }
}
try {
  run(`(() => { setCtx(document.createElement('canvas').getContext('2d'));
       newGame(); S.plot.final.ending = 'E29'; drawEndingScene(2);
       S.plot.final.ending = 'E16'; drawEndingScene(2);
       S.plot.final.ending = 'E27'; drawEndingScene(2); })()`);
} catch (e) { fails++; console.error('  ✗ 结局画面：', e.message); }

// ———————————————— 3c. 选择映射：哪一枚章对应哪个后果 ————————————————
console.log('· 检查选项映射');
const choose = (label, setup, caseFn, dec, state, expect) => {
  run(`(() => { newGame(); S.day = 13; startDay(); PLOT().final.ending = null; ${setup};
    const spec = (${caseFn})(); B.ent = newEntrant(spec, true); handDocs(B.ent);
    spec.onResolved('${dec}', B.ent);
    const q = B.evidenceQueue || [];
    const item = B.evidence || q[q.length - 1];
    if (item && item.onDone) item.onDone('${state}');
  })()`);
  const got = run('S.plot.final.ending');
  ok(String(got) === expect, `${label}：期望 ${expect}，实际 ${got}`);
};
choose('D13 全家迁移', 'PLOT().family.passes=3; S.savings=100', 'caseD13FAMILY', 'approve', 'retained', 'E21');
choose('D13 只送一人', 'PLOT().family.passes=1; S.savings=20', 'caseD13FAMILY', 'approve', 'submitted', 'E22');
choose('D11 含姓名公开', 'PLOT().media.report="raw_pending"', 'caseD11GROKPUBLISH', 'approve', 'retained', 'E12');
run(`(() => { newGame(); S.day = 10; startDay();
  const spec = caseD10KIMI(); B.ent = newEntrant(spec, true); handDocs(B.ent);
  spec.onResolved('approve', B.ent);
  const q = B.evidenceQueue || []; const item = B.evidence || q[q.length - 1];
  if (item && item.onDone) item.onDone('destroyed'); })()`);
ok(run('S.plot.final.ending') === 'E08', 'D10 删除唯一备份应进 E08');

// ———————————————— 3d. 日终门控：D1 小票必须先处理完才收工 ————————————————
console.log('· 检查日终门控');
run(`(() => { newGame(); S.day = 1; startDay(); B.idx = B.queue.length; endDaySoon(); })()`);
run('for (let i = 0; i < 8; i++) { now += 1; runTimers(); }');
ok(run('B.ending') === false, 'D1 打印小票时不应立刻收工');
ok(run('!!B.keepable'), 'D1 应出现可收藏的小票');
run(`(() => { const inst = B.docs.find((d) => d.key === 'zticket'); inst.x = 240; inst.y = 330; resolveKeepable('keep'); })()`);
run('for (let i = 0; i < 5; i++) { now += 1; runTimers(); }');
ok(run("S.plot.evidence.zeroTicket") === 'retained', '收进档案后应记为 retained');
ok(run('B.ending') === true, '处理完小票后应进入收工流程');

// ———————————————— 4. 证据状态字典 ————————————————
console.log('· 检查状态字典');
const st = run('Object.keys(ensurePlot().evidence)');
ok(st.length === 10, `证据种类 ${st.length}`);
run('newGame()');
ok(run("ensurePlot().final.ending === null"), '新档结局应为 null');

// ———————————————— 5. 旧存档迁移 ————————————————
console.log('· 检查旧存档迁移');
run(`newGame(); const old = JSON.parse(JSON.stringify(S)); delete old.plot; old.day = 5;
  localStorage.setItem('ip-please-save-v1', JSON.stringify(old));`);
const save = run("loadSave()");
ok(save && save.day === 5, '旧存档应能读出');
run("newGame(); migrateSave(loadSave());");
ok(run("!!S.plot && S.plot.fish.status === 'active'"), '旧存档迁移后应补齐 plot');

console.log(fails ? `\n✗ 有 ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
