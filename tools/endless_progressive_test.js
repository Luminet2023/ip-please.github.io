'use strict';
const assert=require('node:assert/strict'),create=require('./test_runtime');
const tick=()=>new Promise(r=>setImmediate(r));
const groups=[['region','photo'],['tz'],['pay'],['quiz','xray'],['date','issuing'],['model','registry','corp'],['permit'],['net','wanted','bulletin']];
const view=stage=>({run_id:'run_'+'b'.repeat(22),generator_version:3,status:'active',travelers:stage*5,processed:stage*5,progression:{stage,active_rules:groups.slice(0,stage+1).flat(),new_rules:groups[stage],next_unlock_at:stage===7?null:(stage+1)*5,next_rules:groups[stage+1]||[]}});
(async()=>{
 const {run,sandbox}=create(7);let calls=0,nextRun=view(1),item=null;
 sandbox.CloudSync={ui:{closeDialog(){},toast(){}},api:async(path)=>{calls++;return {run:nextRun,item};}};
 await run('Endless.resume()');run('setCtx(document.createElement("canvas").getContext("2d"));startDay();scene="booth";');
 assert.deepEqual(JSON.parse(run('JSON.stringify(new Rulebook(7).pages.flatMap(p=>Object.keys(p.fields)).sort())')),['photo','region','tz']);
 assert.equal(run('endlessSkill("quiz")'),false);run('now+=5;B.flash=null;hintText();');assert.equal(run('endlessSkill("xray")'),false);
 run('quiz();detain();setXray(true);');assert.equal(run('B.xray.on'),false);
 await run('Endless.callNext()');assert.equal(calls,1,'dispatch waits for actual review');
 run('toggleRules()');await tick();await tick();assert.equal(run('B.ruleInst.doc.fields.tz!==undefined'),true);
 await run('Endless.callNext()');assert.equal(calls,2);
 // A new server stage refreshes the already open book in its dragged position.
 run('B.ruleInst.x=350;B.ruleInst.y=135;');nextRun=view(2);await run('Endless.callNext()');run('ConstitutionGuide.update()');
 assert.equal(run('B.ruleInst.x'),350);assert.equal(run('B.ruleInst.y'),135);
 assert.equal(run('B.ruleInst.doc.fields.pay!==undefined'),true);assert.equal(run('ConstitutionGuide.unread()'),true);
 await run('Endless.callNext()');assert.equal(calls,3);
 run('ConstitutionGuide.click(528,330)');await tick();await tick();
 await run('Endless.resume()');run('startDay();scene="booth";');await run('Endless.callNext()');assert.equal(calls,5,'ack survives resume');
 console.log('✓ actual fields/tools, dispatch barrier, already open dragged book, per-run durable review/resume');
 // Pending travelers remain pending until actual review; reduced motion uses the same barrier.
 nextRun={...view(3),run_id:'run_'+'c'.repeat(22)};
 item={item_type:'traveler',entrant:{entrant_id:'ent_'+'a'.repeat(22),seq:16,person:'P03',voice:140,intro:[],primary:'pp',docs:[],logins:[],xray:[]},progress:{found:[],quiz:null}};
 sandbox.matchMedia=()=>({matches:true});
 await run('Endless.resume()');run('startDay();scene="booth";ConstitutionGuide.draw();');assert.equal(run('B.ent'),null);
 run('toggleRules()');await tick();await tick();assert.equal(run('B.ent.spec.srv.entrant_id'),item.entrant.entrant_id);
 assert.equal(run('ConstitutionGuide.unread()'),false);assert.equal(run('endlessSkill("quiz")'),true);
 console.log('✓ pending traveler waits for static reduced-motion review and is restored once');
 // A failed host flush cannot acknowledge or deadlock: clicking the book retries.
 item=null;nextRun={...view(4),run_id:'run_'+'d'.repeat(22)};let fail=true;
 sandbox.GameHost={flush:()=>fail?Promise.reject(Error('storage')):Promise.resolve()};
 await run('Endless.resume()');run('startDay();scene="booth";toggleRules()');await tick();await tick();assert.equal(run('ConstitutionGuide.unread()'),true);
 fail=false;run('ConstitutionGuide.click(528,330)');await tick();await tick();assert.equal(run('ConstitutionGuide.unread()'),false);
 console.log('✓ failed persistence keeps guide pending and actual book click retries');
 // Every stage exposes usable real hit targets in all four languages; future keys remain absent.
 for(const lang of ['zh','zh-hant','en','ja'])for(let stage=0;stage<8;stage++){
  sandbox.fixtureRun=view(stage);run(`Endless.run=()=>fixtureRun;setLang('${lang}');newGame();S.endless=true;S.day=7;startDay();var rb=new Rulebook(7);`);
  const visible=JSON.parse(run('JSON.stringify([...new Set(rb.pages.flatMap(p=>Object.keys(p.fields)))].sort())'));
  assert.deepEqual(visible,groups.slice(0,stage+1).flat().sort());
  for(const key of groups[stage]){
   run(`rb.page=rb.pages.findIndex(p=>p.fields['${key}']);B.docs=[{key:'rule',owner:'desk',big:true,x:230,y:135,doc:rb}];rb.draw(230,135);`);
   assert.equal(run(`fieldAt(230+(rb.fields['${key}'][0]+rb.fields['${key}'][2])/2,135+(rb.fields['${key}'][1]+rb.fields['${key}'][3])/2).key`),'rule.'+key);
  }
 }
 run('setLang("en");newGame();S.endless=false;S.day=1;var drawn=[];var originalTxt=txt;txt=(...a)=>{drawn.push(a[2]);originalTxt(...a)};new Rulebook(1).draw(230,135);txt=originalTxt;');
 assert.equal(run('drawn.includes("DAY 1")'),true,'story book retains the original day label');
 console.log('✓ 32 stage/language combinations expose only active rules with real fieldAt targets');
})().catch(e=>{console.error(e);process.exitCode=1;});
