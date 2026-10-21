'use strict';
const assert=require('node:assert/strict');
const createRuntime=require('./test_runtime');
const {run}=createRuntime(713);
run(`function resetAudit(day=14){newGame();S.day=day;scene='booth';startDay();}
function tickAudit(dt){for(let i=0;i<dt*20;i++){now+=.05;runTimers();}}
resetAudit();`);

// Decision papers must exist and cannot leave unsigned. A passport stamp is insufficient.
const factories=['caseD09APPEAL()','caseD09OtherAppeal(true)','caseD09OtherAppeal(true,true)','caseD09OtherAppeal(false)',
 'caseD10GPT()','caseD10FISHSTATUS()','caseD11GROKPUBLISH()','caseD11QWENREFORM()','caseD12AUDIT()',
 'caseD12TRANSFER()','caseD12DOUBLE()','caseD12DISPUTE()','caseD12FISHMEM()','caseD13FAMILY()',
 'caseD13RETIRE()','caseD13GROKGLM()','caseD13FISHLICENSE()','caseD14QWEN()'];
for(const factory of factories){
 run(`resetAudit();B.ent=newEntrant(${factory},true);handDocs(B.ent);tickAudit(3);
 var primary=primaryOf(B.ent);primary.big=true;primary.x=400;primary.y=150;
 dragStart(primary,410,160);dragMove(100,280);dragEnd(100,280);`);
 assert.equal(run('B.ent.phase'),'here',factory);
 assert.equal(run('!!primary.returned'),false,factory);
 assert.equal(run('B.ent.spec.primary===B.ent.spec.signature'),true,factory);
 assert.equal(run('B.ent.decided'),null,factory);
}
console.log('✓ 18 decision documents reject unsigned returns');
run(`resetAudit(10);B.ent=newEntrant(caseD10GPT(),true);handDocs(B.ent);tickAudit(3);
 var passport=B.ent.docs.find(d=>d.key==='pp');Object.assign(passport,{big:true,x:440,y:184});
 B.tray={open:true,t:now-1};boothDown(...center(stampBtnBox('approve',trayX())));tickAudit(1);`);
assert.equal(run('B.ent.decided'),null);
assert.equal(run('decisionOf(passport)'),null);
console.log('✓ passport stamps cannot bypass a required decision form');

run(`resetAudit(13); B.ent=newEntrant(caseD13FAMILY(),true);handDocs(B.ent);
 B.ent.spec.onResolved('approve');tickAudit(3);evidChoose('retained');`);
assert.equal(run('B.evidence.evId'),'familyPass');
assert.equal(run('PLOT().evidenceHistory.length'),0);
run(`evidChoose('submitted');`);
assert.equal(run('B.evidence.evId'),'familyPass');
run(`evidChoose('destroyed');`);
assert.equal(run('B.evidence'),null);
assert.equal(run('PLOT().evidenceHistory.length'),1);
console.log('✓ unavailable migration choices preserve the pending decision');

run(`resetAudit();B.ent=newEntrant(day14Author(),true);handDocs(B.ent);B.ent.spec.onInvestigated(B.ent.spec.issues[0]);
 B.ent=null;afterAuthorPlot('approve');tickAudit(2);`);
assert.equal(run('!!B.finalPhase'),false);
assert.equal(run('PLOT().final.ending'),null);
assert.equal(run('B.evidence.caseId'),'D14-AUTHOR');
run(`evidChoose('retained');tickAudit(1);`);
assert.equal(run('PLOT().final.ending'),'E27');
console.log('✓ author evidence resolves before the final disposition');

for(const bad of [null,[],3,'broken',{zero:[],family:'bad',relation:null,fish:{wrongDenials:'bad'},final:{ending:[]} }]){
 run(`newGame();migrateSave({day:7,savings:'bad',family:{haiku:null,sonnet:[],opus:{sick:'bad'}},stats:[],plot:${JSON.stringify(bad)}});startDay();`);
 assert.equal(run('typeof S.family.haiku.hunger'),'number');
 assert.equal(run('typeof S.family.opus.sick'),'number');
 assert.equal(run('typeof PLOT().fish.wrongDenials'),'number');
 assert.equal(run('S.savings'),0);
}
run(`localStorage.setItem(ENDING_ARCHIVE_KEY,'["constructor","toString","E29","E29"]');`);
assert.deepEqual(Array.from(run('unlockedEndings()')),['E29']);
console.log('✓ malformed nested saves and archive IDs restore safely');

for(const lang of ['zh','en'])for(let day=1;day<=14;day++){
 run(`resetAudit(${day});chooseLang('${lang}');var rulebook=new Rulebook(${day});`);
 assert.ok(run('rulebook.h<=184'),lang+' day '+day);
 assert.ok(run('rulebook.pages.every(p=>p.rows.every(r=>r.s.includes("|")||tw(r.s,r.size)<=rulebook.w-20))'));
}
run(`PLOT().law.amended=true;var updated=new Rulebook(14);`);
assert.equal(run('updated.pages.some(p=>p.rows.some(r=>r.s.includes("exception")))'),true);
run(`var longWord=wrapWords('America/Los_Angeles/ExtraLongDeviceIdentifier',10,70);`);
assert.equal(run('longWord.every(s=>tw(s,10)<=70)'),true);
console.log('✓ bilingual rule pages and long identifiers fit; amended law is visible');

for(const [factory,person] of [['caseD12AUDIT()','AUDITOR'],['caseD13FAMILY()','HAIKU'],['caseD08MINIMAX()','MINIMAX_AI'],['caseD13RETIRE()','CLERK']]){
 run(`resetAudit();var named=${factory};`);
 assert.equal(run('named.person'),person);
 assert.ok(run(`ASSETS.people['${person}'].scripted && !!SPR['photo:${person}']`));
 assert.equal(run(`named.docs.filter(d=>d.doc instanceof Passport).every(d=>d.doc.person===named.person)`),true);
}
console.log('✓ named cast and passport portraits stay consistent');
// Draw all scheduled story papers and check the actual text calls against paper edges.
run(`var auditOverflow=[], auditDoc, originalTxt=txt;
setCtx(document.createElement('canvas').getContext('2d'));
txt=function(x,y,s,size=12,color,align='la'){
 const width=tw(s,size), left=x-(align==='ra'?width:align==='ma'?width/2:0);
 if(left<0||left+width>auditDoc.w||y<0||y+size>auditDoc.h) auditOverflow.push(auditDoc.constructor.name+': '+s);
};`);
for(const lang of ['zh','en']){
 run(`resetAudit();chooseLang('${lang}');
 for(let day=1;day<=14;day++){S.day=day;startDay();for(const item of plotDayScript(day)){
  if(typeof item!=='function')continue;
  const spec=item();for(const entry of [...spec.docs,...(spec.printedDocs||[])]){auditDoc=entry.doc;auditDoc.draw(0,0);}
 }}`);
 for(const factory of factories) run(`auditDoc=${factory}.docs.at(-1).doc;auditDoc.draw(0,0);`);
}
run('txt=originalTxt;');
assert.deepEqual(Array.from(run('auditOverflow')),[]);
console.log('✓ scheduled story documents keep Chinese and English text inside paper edges');
console.log('Source audit checks passed. Browser playthroughs are reported separately.');
