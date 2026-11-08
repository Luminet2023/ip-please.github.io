// Real built IIFE -> opaque SDK fixture -> signed HTTP -> real Rust/MySQL.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const launchChromium=()=>require(process.env.PLAYWRIGHT_CORE||'/home/luminet/.nvm/versions/node/v22.22.2/lib/node_modules/camoufox/node_modules/playwright-core').chromium.launch({headless:true});
const out=process.env.BROWSER_ARTIFACTS||'/tmp/ip-please-task4-browser';fs.mkdirSync(out,{recursive:true});
async function run({startBackend,launchBrowser=launchChromium}={}){
 startBackend ||= (await import('./backend-bridge.mjs')).startBackend;let fixture,browser;
 try{
  fixture=await startBackend();browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1280,height:720},locale:'en-US',timezoneId:'America/New_York'}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(fixture.url);let frame=page.frames().find(f=>f.url().endsWith('/frame'));
  const ready=async()=>{frame=page.frames().find(f=>f.url().endsWith('/frame'));await frame.locator('#host-shell').waitFor({state:'hidden',timeout:30000});};
  const click=async(x,y)=>{const b=await frame.locator('#game').boundingBox();await page.mouse.click(b.x+x*b.width/640,b.y+y*b.height/360);};
  const drag=async(x1,y1,x2,y2)=>{const b=await frame.locator('#game').boundingBox();await page.mouse.move(b.x+x1*b.width/640,b.y+y1*b.height/360);await page.mouse.down();await page.mouse.move(b.x+x2*b.width/640,b.y+y2*b.height/360,{steps:10});await page.mouse.up();};
  const title=async()=>{await ready();await click(480,155);await page.waitForTimeout(1200);await click(320,250);await page.waitForTimeout(1800);};
  const shot=async name=>page.screenshot({path:path.join(out,name+'.png')});
  const waitCall=async(op,count=1)=>{for(let i=0;i<100;i++){const matches=fixture.calls.filter(c=>c.request?.op===op);if(matches.length>=count)return matches.at(-1);await page.waitForTimeout(100);}throw Error('No bridge operation '+op);};
  await title();await shot('backend-title');const before=await fixture.audit();
  await click(420,304);await frame.getByRole('button',{name:'ENDLESS',exact:true}).click();await frame.locator('#cloud-overlay').waitFor({state:'hidden'});await page.waitForTimeout(2500);await click(15,298);await page.waitForTimeout(4200);
  const next=await waitCall('run_next');assert.equal(next.response.status,200);assert.equal(next.response.body.run.generator_version,2);
  // Random entrants have different spoken introductions. Wait for the actual
  // passport icon's gold centre, rather than dragging before handDocs renders it.
  await frame.waitForFunction(()=>{
   const p=document.querySelector('#game').getContext('2d').getImageData(57,271,1,1).data;
   return p[0]===190 && p[1]===160 && p[2]===100;
  },null,{timeout:30000});
  await drag(54,270,470,185);
  // Actual passport header and photograph hit targets produce a server inspection, even when no discrepancy matches.
  await click(618,338);await click(530,180);await click(470,210);await page.waitForTimeout(600);
  // Record screenshot even on a hit-coordinate regression, to make it diagnosable.
  await shot('backend-inspection');
  await waitCall('run_inspect');await click(618,338);
  // Lose the real successful response AFTER the server commits; visible unknown-receipt state must survive reopening.
  await page.evaluate(()=>{preview.loseNextAction=true;preview.offlineAfterLoss=true;});
  await click(633,224);await page.waitForTimeout(400);await click(512,224);await page.waitForTimeout(800);await drag(470,185,100,270);await page.waitForTimeout(1400);
  const decision=await waitCall('run_decision');assert.equal(decision.response.status,200);const committed=await fixture.audit();
  await frame.locator('#host-storage').waitFor({state:'visible'});assert.match(await frame.locator('#host-storage').innerText(),/unconfirmed|acknowledg|confirm|尚未确认/i);await shot('backend-unknown-receipt');
  await page.reload();await ready();await frame.locator('#host-storage').waitFor({state:'visible'});await frame.locator('#host-storage-retry').click();await frame.locator('#host-storage').waitFor({state:'hidden'});
  const replay=await waitCall('run_decision',2);assert.equal(replay.request.request_id,decision.request.request_id);assert.deepEqual(replay.response.body,decision.response.body);assert.deepEqual(await fixture.audit(),committed);
  await page.reload();await title();await click(420,304);await frame.getByRole('button',{name:'Continue',exact:true}).click();await page.waitForTimeout(2300);await shot('backend-resumed');
  // Settle through the real lobby action, then query all three platform boards; website board count stays fixed.
  await page.reload();await title();await click(420,304);await frame.getByRole('button',{name:'Abandon run',exact:true}).click();await page.waitForTimeout(800);await waitCall('run_abandon');
  await page.evaluate(()=>preview.failAvatar=true);await frame.getByRole('button',{name:'Leaderboard',exact:true}).click();await page.waitForTimeout(500);assert.ok(await frame.locator('.board .avatar-slot').count());assert.equal(await frame.locator('.board img').count(),0);assert.ok((await frame.locator('.board .avatar-slot').first().innerText()).length);await shot('backend-board-avatar-fallback');
  for(const label of ['This week','Today']){await frame.getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(400);}
  assert.equal((await fixture.audit()).web_scores,before.web_scores);
  await frame.locator('#cloud-overlay').getByRole('button',{name:'Close',exact:true}).click();
  // A second client writes a valid story snapshot through the same real signed API.
  const runtime=require('../../tools/test_runtime')(7);runtime.run('newGame();S.day=2;');const payload=JSON.parse(runtime.run('JSON.stringify(S)'));
  const remoteSave=async base=>page.evaluate(async({payload,base})=>{const response=await fetch('/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'action',account:preview.account,channel:'sandbox',options:{json:{request_id:'req_'+crypto.randomUUID().replaceAll('-',''),op:'save',args:{day:2,payload,base_version:base}}}})});return response.json();},{payload,base});
  assert.equal((await remoteSave(0)).status,200);
  await frame.locator('#cloud').click();await frame.getByRole('button',{name:'Restore from cloud',exact:true}).click();await page.evaluate(()=>preview.failStorage=true);await frame.getByRole('button',{name:'Load cloud save',exact:true}).click();await frame.locator('#host-storage').waitFor({state:'visible'});await shot('storage-failure');
  await page.evaluate(()=>preview.failStorage=false);await frame.locator('#host-storage-retry').click();await page.waitForTimeout(1000);await title();
  await click(178,304);await page.waitForTimeout(2800);await click(320,250);await page.waitForTimeout(800);await shot('backend-story-day2');
  assert.equal((await remoteSave(1)).status,200);
  await frame.locator('#cloud').click();await frame.getByRole('button',{name:'Sync now',exact:true}).click();await frame.getByRole('button',{name:'Keep local',exact:true}).waitFor();await shot('backend-save-conflict');
  await frame.getByRole('button',{name:'Keep local',exact:true}).click();await page.waitForTimeout(500);
  const saves=fixture.calls.filter(c=>c.request?.op==='save');assert.ok(saves.some(c=>c.response.status===409));assert.equal(saves.at(-1).response.body.version,3);
  // Offline preserves a pending original envelope and the UI explains retry.
  await page.evaluate(()=>preview.offline=true);await frame.getByRole('button',{name:'Sync now',exact:true}).click();await frame.locator('#host-storage').waitFor({state:'visible'});await shot('backend-offline');
  await page.evaluate(()=>preview.offline=false);await frame.locator('#host-storage-retry').click();await frame.locator('#host-storage').waitFor({state:'hidden'});assert.equal(fixture.calls.filter(c=>c.request?.op==='save').at(-1).response.body.version,4);
  // Real SDK-boundary deadline; no server response is fabricated.
  await page.evaluate(()=>preview.timeoutNext=true);await frame.getByRole('button',{name:'Sync now',exact:true}).click();await page.waitForTimeout(20500);await frame.locator('#host-storage').waitFor({state:'visible'});await shot('backend-timeout');
  await frame.locator('#host-storage-retry').click();await frame.locator('#host-storage').waitFor({state:'hidden'});assert.equal(fixture.calls.filter(c=>c.request?.op==='save').at(-1).response.body.version,5);
  // Daily: fetch an entrant, reopen unchanged pending state, abandon without judging, and verify daily rank.
  // Full 40-traveler completion is covered by real MySQL integration tests.
  await page.reload();await title();await click(420,304);await frame.getByRole('button',{name:'DAILY CHALLENGE',exact:true}).click();await frame.locator('#cloud-overlay').waitFor({state:'hidden'});await page.waitForTimeout(2500);await click(15,298);await page.waitForTimeout(4200);
  const dailyNext=await waitCall('run_next',2);assert.equal(dailyNext.response.body.run.mode,'daily');
  await page.reload();await title();await click(420,304);await frame.getByRole('button',{name:'Abandon run',exact:true}).click();await page.waitForTimeout(800);
  const dailyEnd=await waitCall('run_abandon',2);assert.equal(dailyEnd.response.body.run.mode,'daily');assert.equal(dailyEnd.response.body.run.travelers,0);assert.ok(dailyEnd.response.body.final.ranks.daily>=1);
  const resumedDaily=fixture.calls.filter(c=>c.request?.op==='run_current'&&c.response.body.run?.mode==='daily').at(-1);assert.equal(resumedDaily.response.body.item.entrant.entrant_id,dailyNext.response.body.item.entrant.entrant_id);
  await frame.getByRole('button',{name:'Leaderboard',exact:true}).click();await frame.getByRole('button',{name:'Today',exact:true}).click();await page.waitForTimeout(500);await shot('backend-daily-settled');
  const dailyBoard=fixture.calls.filter(c=>c.request?.op==='leaderboard'&&c.request.board==='daily').at(-1);assert.equal(dailyBoard.response.body.me.linuxdo_id,fixture.subject);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'backend-calls.json'),JSON.stringify(fixture.calls,null,2));console.log('Real Rust/MySQL built-IIFE start/inspect/decision/lost response/reopen/replay/settle/boards/avatar fallback/day2/save conflict/storage failure/offline/timeout retries/daily settlement passed');
 }finally{
  try {if(fixture)fs.writeFileSync(path.join(out,'backend-calls.json'),JSON.stringify(fixture.calls,null,2));}
  finally {try {if(browser)await browser.close();}finally {if(fixture)await fixture.close();}}
 }
}
module.exports={run};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
