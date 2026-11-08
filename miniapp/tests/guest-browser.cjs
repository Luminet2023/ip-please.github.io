// Built IIFE, opaque iframe and real pointer interactions. Prior guest day2 is seeded
// through SDK storage fixture (not a claim of a natural browser day1 playthrough).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_CORE||'/home/luminet/.nvm/versions/node/v22.22.2/lib/node_modules/camoufox/node_modules/playwright-core');
const out=process.env.BROWSER_ARTIFACTS||'/tmp/ip-please-guest-browser';fs.mkdirSync(out,{recursive:true});
(async()=>{
 let fixture,server,browser;const backend=process.argv.includes('--backend');
 try {
  if(backend)fixture=await (await import('./backend-bridge.mjs')).startBackend();else server=await (await import('../preview/server.mjs')).serve(0);
  const base=fixture?.url||'http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
  for(const conflict of [false,true]) {
   const context=await browser.newContext({viewport:{width:1280,height:720},locale:'en-US'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
   const r=require('../../tools/test_runtime')(7);r.run('newGame();S.day=2;S.savings=100;');const payload=JSON.parse(r.run('JSON.stringify(S)'));
   const account=backend?Number(fixture.subject)+(conflict?1:0):(conflict?43:42);
   const url=new URL(base);url.searchParams.set('guest','1');
   // A saved prior guest day is written by the parent SDK fixture, then read by the real host.
   await context.addInitScript(({payload})=>{if(window!==top)return;localStorage.setItem('sandbox:ip-please:anonymous:v2:shared:key:'+encodeURIComponent('ip-please-file-zero-save-v1'),JSON.stringify(JSON.stringify(payload)));localStorage.setItem('sandbox:ip-please:anonymous:v2:shared:key:'+encodeURIComponent('ip-please-file-zero-lang'),JSON.stringify('en'));},{payload});
   const before=fixture?.calls.length||0;await page.goto(url.href);
   let frame=page.frames().find(f=>f.url().endsWith('/frame'));
   const ready=()=>frame.locator('#host-shell').waitFor({state:'hidden'});
   const click=async(x,y)=>{const b=await frame.locator('#game').boundingBox();await page.mouse.click(b.x+x*b.width/640,b.y+y*b.height/360);};
   const title=async()=>{await ready();await click(480,155);await page.waitForTimeout(1200);await click(320,250);await page.waitForTimeout(1800);};
   await title();await frame.locator('#cloud').click();assert.match(await frame.locator('#cloud-panel').innerText(),/14-day.*30 endings/);assert.match(await frame.locator('#cloud-panel').innerText(),/File Zero/);
   await frame.locator('#cloud-panel').getByRole('button',{name:'Log in',exact:true}).click();assert.match(await frame.locator('#toast').innerText(),/Sign in on LINUX DO/);assert.equal((await page.evaluate(()=>preview.calls.filter(c=>c.method==='http'||c.method==='lookup'))).length,0);
   await frame.locator('#cloud-panel').getByRole('button',{name:'Close',exact:true}).click();await click(178,304);await page.waitForTimeout(2800);await click(320,250);await page.waitForTimeout(800);await click(15,298);await page.waitForTimeout(2200);await page.screenshot({path:path.join(out,(backend?'backend-':'')+'guest-story-'+conflict+'.png')});
   assert.equal(fixture?.calls.length||0,before);
   // Reopen the exact packaged iframe; parent SDK store and guest identity remain.
   await frame.goto(new URL('/frame',base).href);await title();
   const stored=await page.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem('sandbox:ip-please:anonymous:v2:shared:key:'+encodeURIComponent('ip-please-file-zero-save-v1')))));assert.equal(stored.day,2);
   if(conflict){
    if(backend){const remote=await page.evaluate(async({account,payload})=>{const res=await fetch('/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'action',account,channel:'production',options:{json:{request_id:'req_'+crypto.randomUUID().replaceAll('-',''),op:'save',args:{day:2,payload,base_version:0}}}})});return res.json();},{account,payload});assert.equal(remote.status,200);}
    else await page.evaluate(payload=>preview.cloud={day:2,version:1,payload},payload);
   }
   const callsBeforeLogin=fixture?.calls.length||0;
   await page.evaluate(account=>preview.account=account,account);await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
   await page.waitForFunction(()=>preview.calls.some(c=>c.method==='http'&&c.args[0]==='action'&&c.args[1].json.op==='save'));
   await ready();
   if(conflict){await frame.getByRole('button',{name:'Keep local',exact:true}).waitFor();await page.screenshot({path:path.join(out,(backend?'backend-':'')+'guest-cloud-choice.png')});await frame.getByRole('button',{name:'Keep local',exact:true}).click();}
   await page.waitForFunction(version=>Object.entries(localStorage).some(([k,v])=>k.includes(':v2:shared:ack:') && JSON.parse(v).meta?.version>=version),conflict?2:1);
   if(backend){const actual=fixture.calls.slice(callsBeforeLogin),saveCalls=actual.filter(c=>c.name==='action'&&c.request?.op==='save');assert.equal(saveCalls.length,conflict?2:1);assert.equal(saveCalls[0].request.args.base_version,0);assert.equal(saveCalls.at(-1).response.status,200);assert.equal(saveCalls.at(-1).request.args.payload.day,2);if(conflict)assert.equal(saveCalls[0].response.status,409);}
   else assert.equal(await page.evaluate(()=>preview.cloud.payload.day),2);
   await page.screenshot({path:path.join(out,(backend?'backend-':'')+'guest-autosynced-'+conflict+'.png')});assert.deepEqual(errors,[]);await context.close();
   console.log((backend?'real Rust/MySQL':'SDK fixture')+': guest local story/reopen -> SDK login visibility -> '+(conflict?'explicit shared-channel cloud conflict':'immediate automatic upload')+' passed');
  }
 } finally {if(browser)await browser.close();if(fixture)await fixture.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
})().catch(e=>{console.error(e);process.exitCode=1;});
