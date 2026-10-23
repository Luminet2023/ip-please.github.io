// 跑一遍全部剧情，列出英文模式缺译文的键：node tools/missing_en.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const { sandbox, run } = require('./test_runtime')();
run('setLang("en"); chooseLang("en");');
for (let day = 1; day <= 14; day++) {
  for (const dec of ['approve', 'deny', 'detain']) {
    run(`(() => { newGame(); ensurePlot().evidence.zeroTicket='retained'; ensurePlot().law.contradiction=true;
      ensurePlot().evidence.oldRule='retained'; ensurePlot().evidence.auditLog='retained';
      ensurePlot().evidence.glmSign='retained'; ensurePlot().evidence.purgeOrder='retained';
      ensurePlot().zero.verified=true; ensurePlot().media.footageVerified=true; ensurePlot().media.report='redacted_ready';
      ensurePlot().network.mission='open'; ensurePlot().fish.licensed=true; ensurePlot().gpt.revoked=true;
      ensurePlot().relation.gpt=2; ensurePlot().gpt.purgeKnown=true; ensurePlot().fish.trust=3;
      S.savings=200; S.day=${day}; startDay();
      const n = B.queue.length;
      for (let i=0;i<n;i++){
        if (typeof B.queue[B.idx] === 'undefined') break;
        if (isEvent(nextItem())) { B.idx++; continue; }
        const item = B.queue[B.idx++];
        const spec = typeof item === 'function' ? item() : item;
        const e = newEntrant(spec, true); B.ent = e; handDocs(e); judge(e, '${dec}');
        let g=0; while (B.evidence && g++<6) evidChoose(['retained','submitted','destroyed'][g%3]);
      }
    })()`);
  }
}
run(`(() => { setCtx(document.createElement('canvas').getContext('2d')); newGame(); S.day=14;
  for (const id of Object.keys(ENDINGS)) { S.plot.final.ending = id; drawEndingScene(3); } })()`);
const missing = run('[...untranslated]');
console.log(missing.length ? missing.map((s) => JSON.stringify(s) + ': ,').join('\n') : '(no missing)');
console.error('共缺 ' + missing.length);
