#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const createRuntime = require('./test_runtime');
const fixtures = require('./ending_fixtures.json');
let tests = 0;
function test(name, fn) { fn(); tests++; console.log('✓ ' + name); }

function runtime(seed) {
  const { run } = createRuntime(seed);
  run(`
    function advance(seconds) {
      for (let i = 0; i < Math.ceil(seconds * 20); i++) { now += 0.05; if (scene === 'booth') runTimers(); }
    }
    function resetTest(day = 14) {
      newGame(); S.day = day; scene = 'booth'; sceneT0 = now;
      startDay(); setCtx(document.createElement('canvas').getContext('2d'));
    }
    function chooseEvidence(state = 'retained') {
      let limit = 0;
      while ((B.evidence || (B.evidenceQueue || []).length) && !PLOT().final.ending) {
        if (++limit > 12) throw Error('Evidence did not finish');
        advance(3);
        if (!B.evidence) continue;
        B.tray = { open: true, t: now - 1 };
        const [box] = evidButtons(trayX())[['retained','submitted','destroyed'].indexOf(state)];
        boothDown(...center(box));
        advance(1);
      }
    }
    function investigate(e) {
      for (const issue of e.spec.issues || []) {
        if (issue.all || !issue.pairs || !issue.pairs.length) continue;
        const pair = issue.pairs[0];
        if (pair.some(key => key.startsWith('rule.') || key === 'face' || !key.includes('.'))) continue;
        for (const d of B.docs) d.big = false;
        const docs = [...new Set(pair.map(key => key.slice(0, key.indexOf('.'))))];
        docs.forEach((key, i) => {
          const d = e.docs.find(d => d.key === key);
          if (!d) throw Error(e.spec.caseId + ' missing document ' + key);
          Object.assign(d, { big: true, x: 224 + i * 208, y: 130 });
        });
        setInspect(true);
        for (const key of pair) {
          const dot = key.indexOf('.'), d = e.docs.find(d => d.key === key.slice(0, dot));
          const field = d.doc.fields[key.slice(dot + 1)];
          if (!field) throw Error(e.spec.caseId + ' missing field ' + key);
          inspectClick(d.x + (field[0] + field[2]) / 2, d.y + (field[1] + field[3]) / 2);
        }
        if (!e.found.has(issue)) throw Error(e.spec.caseId + ' unreachable inspection ' + pair.join(' / '));
        setInspect(false);
      }
    }
    function resolveTestCase(spec, verdict, check = false, evidenceState = 'retained') {
      const e = newEntrant(spec, true); B.ent = e; handDocs(e); advance(3);
      if (check) investigate(e);
      chooseEvidence(evidenceState);
      for (const d of e.docs) d.big = false;
      if (verdict === 'detain') boothDown(...center(DETAIN_BTN));
      else {
        const d = primaryOf(e); Object.assign(d, { big: true, x: 440, y: 184 });
        B.tray = { open: true, t: now - 1 };
        boothDown(...center(stampBtnBox(verdict, trayX()))); advance(0.15);
        if (!decisionOf(d)) throw Error('Stamp did not reach ' + spec.caseId);
        dragStart(d, d.x + 12, d.y + 12); dragMove(100, 270); dragEnd(100, 270);
      }
      advance(28);
      chooseEvidence(evidenceState);
      return e;
    }
    resetTest(); chooseLang('zh');
  `);
  return run;
}

test('30 fixed fixtures reach 30 endings through inspection, stamps and evidence clicks', () => {
  assert.equal(fixtures.length, 30);
  for (const fixture of fixtures) {
    const run = runtime(fixture.seed);
    run(`resetTest(${fixture.day});`);
    for (const [key, value] of Object.entries(fixture.state || {})) run(`S.${key} = ${JSON.stringify(value)};`);
    if (fixture.archive) run(`localStorage.setItem(ENDING_ARCHIVE_KEY, ${JSON.stringify(JSON.stringify(fixture.archive))});`);
    if (fixture.action === 'paper') {
      run(`startFinalPhase(finalPapers(), 'approve');`);
      const ids = run('B.finalPapers.map(p => p.ending)');
      assert.ok(ids.includes(fixture.id), fixture.id + ' unavailable');
      for (let i = 0; i < ids.indexOf(fixture.id); i++) run('boothDown(...center(FINAL_NEXT));');
      run(`advance(1); boothDown(...center(stampBtnBox('approve', trayX()))); advance(0.5);`);
    } else if (fixture.action === 'debt') {
      run(`go('summary'); sceneT0 = now - 10; summaryClick(...center(CONTINUE_BTN));`);
    } else {
      run(`resolveTestCase(${fixture.case}(), '${fixture.verdict}', ${!!fixture.check}, '${fixture.choice || 'retained'}');`);
    }
    assert.equal(run('PLOT().final.ending'), fixture.id, fixture.id);
    assert.ok(run(`unlockedEndings().includes('${fixture.id}')`));
    assert.equal(run(`JSON.parse(localStorage.getItem('ip-please-last-ending-v1')).plot.final.ending`), fixture.id);
    assert.equal(run('loadSave()'), null);
    run(`commitEnding('E27'); advance(10);`);
    assert.equal(run('PLOT().final.ending'), fixture.id, 'ending overwritten');
  }
});

test('fixed cases survive scheduling and the author is last', () => {
  const run = runtime();
  for (let day = 1; day <= 14; day++) {
    run(`resetTest(${day}); constKeys = null;` .replace('constKeys = null;', ''));
    const expected = run(`plotDayScript(${day}).map(x => typeof x === 'function' ? x().caseId : x.type).filter(Boolean)`);
    const actual = run(`B.queue.map(x => typeof x === 'function' ? x().caseId : x.type).filter(Boolean)`);
    assert.ok(run('B.queue.length <= 9'));
    for (const id of expected) assert.ok(actual.includes(id), 'missing ' + id);
    if (day === 14) assert.equal(actual.at(-1), 'D14-AUTHOR');
    if (day === 6) assert.ok(!actual.includes('D14-AUTHOR'));
  }
});

test('evidence buttons write once, block queue, and never stamp a waiting traveller', () => {
  const run = runtime();
  run(`resetTest(5); offerEvidence('glmSign', '数字签名存证', ['公钥：可验证']);
    evidChoose('retained');`);
  assert.equal(run("evd('glmSign')"), 'unknown', 'must wait for printer');
  run(`advance(2); const oldIndex = B.idx; callNext();`);
  assert.equal(run('B.idx'), run('oldIndex'));
  run(`chooseEvidence('submitted');`);
  assert.equal(run("evd('glmSign')"), 'submitted');
  assert.equal(run('PLOT().evidenceHistory.length'), 1);
  assert.equal(run('Object.keys(PLOT().evidence).length'), 10);
});

test('Qwen rule papers inspect and return without becoming the desk rulebook', () => {
  const run = runtime();
  run(`resetTest(2); const q = newEntrant(caseD02QWEN(), true); B.ent=q; handDocs(q);
    const summary=q.docs.find(d=>d.key==='rule');
    Object.assign(summary,{big:true,x:224,y:172});
    setInspect(true); inspectClick(summary.x+12,summary.y+30); setInspect(false);
    dragStart(summary,summary.x+12,summary.y+12); dragMove(100,270); dragEnd(100,270);`);
  assert.equal(run('summary.returned'), true);
  assert.equal(run('B.ruleInst'), null);
  assert.ok(run('q.docs.every(d=>!inBox(d.slot[0]+9,d.slot[1]+6,QUIZ_BTN)&&!inBox(d.slot[0]+9,d.slot[1]+6,DETAIN_BTN))'));
  for (const lang of ['zh','en']) {
    run(`chooseLang('${lang}'); var paper=new PaperDoc({title:'入境规则摘要',lines:['版本：2026.10（本日生效）','出版年份：2026','§1 支持地区：美国 英国 日本 德国 新加坡'],footer:'ARCHIVE COPY'});`);
    assert.ok(run('paper.fields.sign[1]>paper.dividerY+12'));
    assert.ok(run('paper.fields.body[3]<paper.dividerY'));
    assert.ok(run('paper.fields.sign[3]<paper.h'));
  }
});

test('fish denial, custody, proxy hearing and successful appeal are connected', () => {
  const run = runtime();
  run(`resetTest(3); resolveTestCase(fishDay3().fish, 'detain');`);
  assert.equal(run('fishP().status'), 'detained');
  assert.equal(run('fishP().appeal'), 'pending');
  assert.equal(run(`fishCase(4, () => fishDay4().fish)().person`), 'GLM_AI');
  run(`S.day = 9; startDay(); resolveTestCase(caseD09APPEAL(), 'approve');`);
  assert.equal(run('fishP().status'), 'active');
  assert.equal(run('fairFish()'), true);
});

test('law reform requires an actual model identity comparison for the fish license', () => {
  const run = runtime();
  run(`resetTest(13); PLOT().law.amended = true; resolveTestCase(caseD13FISHLICENSE(), 'approve');`);
  assert.equal(run('legalFish()'), false);
  run(`startDay(); resolveTestCase(caseD13FISHLICENSE(), 'approve', true);`);
  assert.equal(run('legalFish()'), true);
  run(`PLOT().law.amended = false;`);
  assert.equal(run('legalFish()'), false);
});

test('ZERO requires both comparisons; the author provides an alternative source', () => {
  const run = runtime();
  run(`resetTest(12); Object.assign(PLOT().evidence, {glmSign:'retained',oldRule:'retained',zeroTicket:'retained',auditLog:'retained'});
    PLOT().law.contradiction = true;
    resolveTestCase(caseD12ZERO(), 'approve');`);
  assert.equal(run('zeroOk()'), false);
  run(`startDay(); resolveTestCase(caseD12ZERO(), 'approve', true);`);
  assert.equal(run('zeroOk()'), true);
  run(`PLOT().zero.verified=false; PLOT().evidence.zeroTicket='unknown'; PLOT().evidence.auditLog='unknown';
    S.day=14; startDay(); resolveTestCase(day14Author(), 'detain', true);`);
  assert.equal(run('threeProofs() && zeroOk()'), true);
  assert.ok(run("B.finalPapers.some(p=>p.ending==='E29')"));
});

test('memory snapshot, migration failure and recovery paper form a playable route', () => {
  const run = runtime(7);
  run(`resetTest(7); PLOT().fish.trust=3; resolveTestCase(caseD07FISH(), 'deny');`);
  assert.equal(run("evd('fishBackup')"), 'retained');
  run(`S.day=12; startDay(); resolveTestCase(caseD12FISHMEM(), 'approve');`);
  assert.equal(run('fishP().memory'), 'lost');
  assert.ok(run("finalPapers().some(p=>p.ending==='E19')"));
});

test('anonymous video publication follows both real fields and the evidence decision', () => {
  const run = runtime();
  run(`resetTest(8); resolveTestCase(caseD08GEMINI(), 'approve', true);`);
  assert.equal(run('PLOT().media.footageVerified'), true);
  run(`resolveTestCase(caseD08GROK(), 'approve', true, 'destroyed');`);
  assert.equal(run('PLOT().media.report'), 'raw_pending');
  assert.equal(run("evd('rawVideo')"), 'known');
  run(`S.day=11; startDay(); resolveTestCase(caseD11GROKPUBLISH(), 'approve', false, 'destroyed');`);
  assert.equal(run('PLOT().media.report'), 'redacted');
  assert.equal(run('PLOT().final.ending'), null);
});

test('printed audit records expose their content for actual inspection', () => {
  const run = runtime();
  run(`resetTest(9); resolveTestCase(caseD09AUDITLOG(),'approve',true);`);
  assert.equal(run("evd('auditLog')"), 'retained');
});

test('unbribed correct play can support all family members and buy three passes', () => {
  const run = runtime();
  run('resetTest(1);');
  for (let day = 1; day <= 12; day++) {
    run(`S.day=${day}; startDay(); B.pay=35; B.total=7; B.correct=7; initSummary();
      for (const key of SUM_PASS_ROWS) if (sumBalance()>=15) SUM.on[key]=true;
      S.family=familyAfter(); S.savings=sumBalance();
      PLOT().family.passes+=SUM_PASS_ROWS.filter(key=>SUM.on[key]).length;`);
    assert.equal(run('familyAllAlive()'), true, 'family lost on day ' + day);
  }
  assert.equal(run('PLOT().family.passes'), 3);
  assert.ok(run('S.savings>=60'));
});

test('endless mode keeps story state and campaign save isolated', () => {
  const run = runtime();
  run(`resetTest(5); saveGame(); const storySave=localStorage.getItem(SAVE_KEY);
    S.endless=true; startDay(); resolveTestCase(fishDay3().fish, 'detain');`);
  assert.equal(run('fishP().status'), 'active');
  assert.deepEqual(run('Object.keys(PLOT().verdicts)'), []);
  assert.equal(run('localStorage.getItem(SAVE_KEY)'), run('storySave'));
});

test('old and damaged saves and archive are migrated safely', () => {
  const run = runtime();
  run(`resetTest(5); const oldSave=JSON.parse(JSON.stringify(S)); delete oldSave.plot;
    oldSave.flags={sawNote:true}; newGame(); migrateSave(oldSave);`);
  assert.equal(run('PLOT().network.contact'), 'open');
  assert.equal(run('S.day'), 5);
  for (const bad of ['null', '{}', '123', '["E29","bad","E29"]']) {
    run(`localStorage.setItem(ENDING_ARCHIVE_KEY, ${JSON.stringify(bad)});`);
    assert.ok(Array.isArray(run('unlockedEndings()')));
  }
});

console.log(`\n${tests} regression groups passed; all 30 endings replayed.`);
