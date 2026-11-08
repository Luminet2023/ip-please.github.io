'use strict';
const assert = require('node:assert/strict');
const { run } = require('./test_runtime')(91234);
run(`var samples = []; for (let i=0;i<1000;i++) samples.push(randomEntrant(7, i%2 ? 'tz' : 'valid'));`);
const samples = JSON.parse(run(`JSON.stringify(samples.map(s => ({country:s.docs[0].doc.country,tz:s.docs[1].doc.rows.find(r=>r[0]==='时区')[1],ok:s.ok})))`));
for (const country of ['UNITED STATES OF AMERICA','UNITED KINGDOM','JAPAN','DEUTSCHLAND','REPUBLIC OF SINGAPORE']) {
  assert.ok(samples.some(s => s.country === country && s.ok.includes('approve')), country+' clean');
  assert.ok(samples.some(s => s.country === country && s.ok.includes('deny')), country+' flawed');
}
assert.ok(samples.filter(s=>s.country==='REPUBLIC OF SINGAPORE'&&s.ok.includes('deny')).every(s=>!['Asia/Shanghai','Asia/Singapore'].includes(s.tz)),'Singapore defect differs from UTC+8');
console.log('✓ local nationality distribution and incompatible timezone');
for (const order of [['oregon','cnip'],['cnip','oregon']]) {
  const facts=JSON.parse(run(`JSON.stringify((()=>{const s=randomEntrant(7,${JSON.stringify(order)});return {loc:s.docs.find(d=>d.key==='dv').doc.rows.find(r=>r[0]==='归属')[1],bill:s.docs.find(d=>d.key==='ac').doc.rows.find(r=>r[0]==='账单')[1],issue:s.issues.find(i=>i.pairs.some(p=>p.includes('ac.账单')))};})())`));
  assert.equal(facts.issue.sub,`账单：${facts.bill}   VS   归属地：${facts.loc}`,order.join(' -> '));
}
console.log('✓ compound billing evidence describes final document facts in both orders');

run(`setCtx(document.createElement('canvas').getContext('2d')); var permit=docFromServer({type:'entry_permit',holder:'TAN, WEI MING',purpose:'research',exp:'2026.10.24'});`);
assert.ok(run('permit'), 'server entry permit is rendered');
for(const key of ['holder','purpose','exp']) assert.ok(run(`permit.fields['${key}']`), 'clickable '+key);
run('permit.draw(10,10); S.endless=true; Endless.run=()=>({generator_version:2,inspection_date:"2026.10.25"}); var book=new Rulebook(7);');
for (const key of ['date','issuing','permit','registry']) assert.ok(run(`book.pages.some(p=>p.fields['${key}'])`),'v2 rule field '+key);
assert.ok(run(`book.pages.flatMap(p=>p.rows).some(r=>r.s.includes('2026.10.25'))`),'fixed shift visible');
console.log('✓ entry permit rendering and v2 rulebook fields');
// Exercise actual fieldAt hit testing after translation and document layout.
for (const lang of ['zh','en','ja','zh-hant']) {
  run(`setLang('${lang}'); newGame(); S.day=7; S.endless=true; startDay(); var p=new EntryPermit({holder:'TAN, WEI MING',purpose:'research',exp:'2026.10.24'}); B.docs=[{key:'ep',owner:'ent',big:true,x:230,y:135,doc:p}]; p.draw(230,135);`);
  for (const key of ['holder','purpose','exp']) assert.equal(run(`fieldAt(230+(p.fields.${key}[0]+p.fields.${key}[2])/2,135+(p.fields.${key}[1]+p.fields.${key}[3])/2).key`),'ep.'+key);
  run('var rb=new Rulebook(7);');
  for (const key of ['date','issuing','permit','registry']) {
    run(`rb.page=rb.pages.findIndex(p=>p.fields['${key}']); B.docs=[{key:'rule',owner:'desk',big:true,x:230,y:135,doc:rb}]; rb.draw(230,135);`);
    assert.equal(run(`fieldAt(230+(rb.fields['${key}'][0]+rb.fields['${key}'][2])/2,135+(rb.fields['${key}'][1]+rb.fields['${key}'][3])/2).key`),'rule.'+key);
  }
}
console.log('✓ translated permit/rulebook draw and actual fieldAt hit targets');
run("setLang('zh');");
for (const person of ['GPT_AI','QWEN_AI','GROK_AI','GLM_AI','KIMI_AI','GEMINI_AI']) {
  run(`newGame(); S.endless=true; S.day=7; startDay(); var e=newEntrant({person:'${person}',voice:140,srv:{},docs:[],intro:[],quiz:null},false); B.ent=e; e.phase='here'; e.handed=true;`);
  assert.equal(run(`issueFromServer({kind:'passport_expired',args:{exp:'2026.10.24',date:'2026.10.25'},fields:['pp.EXP','rule.date']},'${person}').ask.filter(l=>l[0]==='E')[0][1]`),run(`ENDLESS_AI.${person}.ask`));
  for (const decision of ['approve','deny','detain']) assert.equal(run(`endlessReaction(e,'${decision}',{correct:true})[0][1]`),run(`ENDLESS_AI.${person}.${decision}`));
  for (const exposed of [true,false]) {
    run(`B.lines=[]; B.timers=[]; e.quizDone=[]; askQuiz(e,${exposed}); for(var i=0;i<600;i++){now+=.1;runTimers();}`);
    assert.ok(run(`B.lines.some(l=>l.text===ENDLESS_AI.${person}.${exposed?'quizExposed':'quizClear'})`),'actual quiz dialogue '+person);
  }
}
console.log('✓ six AI questioning, decisions and actual quiz dialogue');
