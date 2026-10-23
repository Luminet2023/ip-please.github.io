'use strict';
// Isolated scene fixtures for screenshot reports. After fixture setup, all
// inspections, page turns and document moves use real browser mouse input.
const assert = require('node:assert/strict');
const path = require('path');
module.exports = async ({ page, state, click, dragDoc, waitFor, inspectMode, language, out }) => {
  const checks = [];
  const shot = (name) => page.screenshot({ path: path.join(out, language + '-regression-' + name + '.png') });
  async function fixture(name, day, amended = false, legal = null) {
    await page.evaluate(({ name, day, amended, legal, language }) => {
      newGame(); chooseLang(language); S.day=day; S.plot.law.amended=amended;
      scene='booth'; sceneT0=now; startDay();
      const make = { sticker:caseD04GROK, origin:()=>fishDay5().fish,
        impostor:caseD11API, license:caseD13FISHLICENSE, printer:caseD09AUDITLOG,
        dialogue:caseD07GLM, network:caseD07FISH, login:()=>randomEntrant(7,'logins') }[name];
      let spec=make();
      if(legal!==null) for(let i=0;i<100&&spec.ok.includes('approve')!==legal;i++) spec=make();
      B.ent=newEntrant(spec,true); handDocs(B.ent);
    }, { name, day, amended, legal, language });
  }
  async function move(key,x,y) {
    const d=(await state()).booth.docs.find(d=>d.key===key);
    assert.ok(d,'document '+key+' exists'); await dragDoc(d,x,y);
  }
  async function field(key) {
    const p=await page.evaluate((key)=>{
      for(let y=130;y<318;y+=2)for(let x=222;x<636;x+=2){
        const f=fieldAt(x,y); if(f?.key===key)return [x,y];
      }
      return null;
    },key);
    assert.ok(p,'visible field '+key); await click(...p);
  }
  async function book(rule) {
    await inspectMode(false); await click(...await page.evaluate(() => center(BOOK_BOX)));
    for(let i=0;i<10;i++){
      if((await state()).booth.docs.find(d=>d.key==='rule')?.fields[rule])return;
      const b=(await state()).booth.docs.find(d=>d.key==='rule');
      await click(b.x+b.w-24,b.y+8);
    }
    throw Error('Rule unavailable: '+rule);
  }
  for(const [name,day,rule] of [['origin',5,'corp'],['impostor',11,'model']]){
    await fixture(name,day); await move('md',436,172); await book(rule);
    await inspectMode(true); await field('md.发行'); await field('rule.'+rule);
    assert.ok(await page.evaluate(()=>B.insp.banner?.bad));
    assert.ok((await state()).booth.ent.found>0);
    await shot(name+'-issuer-rule');
    if(name==='impostor'){
      assert.equal((await state()).booth.ent.person,'FISH');
      assert.equal(await page.evaluate(()=>B.ent.spec.docs[0].doc.person),'FISH');
    }
    checks.push(name+' issuer links to the real constitution field');
  }
  await fixture('license',13,true); await move('md',436,172); await book('model');
  await inspectMode(true); await field('md.发行'); await field('rule.model');
  assert.equal(await page.evaluate(()=>B.insp.banner.bad),false);
  checks.push('certified model has no false identity discrepancy');

  await fixture('sticker',4); await move('scan',244,166); await shot('card-layout');
  assert.ok(await page.evaluate(()=>{
    const c=B.ent.spec.docs.find(d=>d.key==='scan').doc;
    return c.layout.every(r=>8+tw(r.label,10)+6<=c.valueX)&&c.textInk===K.WHITE;
  }));
  checks.push('scan note columns and contrasting text');

  for(const legal of [true,false]){
    await fixture('network',7,false,legal); await move('dv',320,156);
    await page.evaluate(()=>{ B.lines=[]; runSteps(B.ent.spec.intro); });
    await page.waitForFunction(()=>B.lines.length===3);
    const dialogue=await page.evaluate(()=>B.lines.map(l=>l.text).join('\n'));
    const expected=await page.evaluate(legal=>T(legal?'这次是住宅宽带。':'你的网络是机房。'),legal);
    assert.ok(dialogue.includes(expected)); await shot(legal?'residential-network':'hosting-network');
    checks.push((legal?'residential':'hosting')+' card agrees with dialogue');
  }

  await fixture('dialogue',7);
  await page.evaluate(()=>{B.lines=[];say('E',B.ent.spec.intro[0][1]);});
  const rows=await page.evaluate(()=>lineBoxes().map(r=>({text:r.seg,off:r.off,full:r.ln.text})));
  assert.equal(rows[0].off,0);
  assert.equal(rows[1].off,[...rows[0].full.slice(0,rows[0].full.indexOf(rows[1].text,rows[0].text.length))].length);
  await shot('dialogue-first-line');
  await page.waitForFunction(()=>{
    const rows=lineBoxes(); return (now-rows[0].ln.t)*(LANG==='en'?50:26)>rows[1].off+2;
  });
  await shot('dialogue-second-line');
  checks.push('second dialogue row reveals after the first');

  await fixture('printer',9);
  assert.equal(await page.evaluate(()=>B.ent.docs.some(d=>d.key==='log')),false);
  assert.equal(await page.evaluate(()=>B.printing?.doc===B.ent.spec.printedDocs[0].doc),true);
  await shot('printer-output');
  await waitFor(s=>s.booth.docs.some(d=>d.key==='log'),'identity log leaves printer');
  assert.equal((await state()).booth.docs.find(d=>d.key==='log').owner,'desk');
  if(language==='en') assert.equal(await page.evaluate(()=>B.docs.find(d=>d.key==='log').doc.rows.some(row=>CJK.test(row))),false);
  await move('log',310,170); await inspectMode(true); await field('log.body');
  assert.equal((await state()).booth.ent.found,1); await shot('printed-log-inspection');
  checks.push('identity log prints at the desk and can be inspected');

  await fixture('login',7);
  await waitFor(s=>s.booth.docs.some(d=>d.key==='log'),'current login verification output');
  assert.equal(await page.evaluate(()=>B.docs.find(d=>d.key==='log').forEntrant===B.ent),true);
  await move('log',224,172); await move('dv',436,172); await inspectMode(true);
  await field('log.last'); await field('dv.归属');
  assert.ok(await page.evaluate(()=>B.insp.banner?.bad)); await shot('login-check');
  checks.push('login printout belongs to the current card and detects a location mismatch');
  const cast=await require('./browser_cast_audit')({page,out,language});
  assert.equal(cast.checks.length,88);
  checks.push('all 88 AI expressions preserve alpha and render over the booth background');
  return checks;
};
