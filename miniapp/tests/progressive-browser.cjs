// Milestone fixtures exercise the actual Canvas source and final opaque IIFE.
// These are positioned stages, not a claimed natural 40/50-traveler playthrough.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_CORE||'/home/luminet/.nvm/versions/node/v22.22.2/lib/node_modules/camoufox/node_modules/playwright-core');
const root=path.resolve(__dirname,'../..'),out=process.env.BROWSER_ARTIFACTS||'/tmp/ip-please-progressive-browser';fs.mkdirSync(out,{recursive:true});
const groups=[['region','photo'],['tz'],['pay'],['quiz','xray'],['date','issuing'],['model','registry','corp'],['permit'],['net','wanted','bulletin']];
const progression=stage=>({stage,completed_travelers:stage*5,active_rules:groups.slice(0,stage+1).flat(),new_rules:groups[stage],next_unlock_at:stage<7?(stage+1)*5:null,next_rules:groups[stage+1]||[],waves_unlocked:stage>=3});
(async()=>{
 const {serve}=await import('../preview/server.mjs');
 const server=await serve(0,async(req,res,url)=>{if(!url.pathname.startsWith('/source/'))return false;const file=path.join(root,url.pathname.slice(8));try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file));}catch(_){res.statusCode=404;res.end();}return true;});
 const url='http://127.0.0.1:'+server.address().port;let browser;
 try{
 browser=await chromium.launch({headless:true});
 for(const [name,touch,reduced] of [['desktop',false,false],['phone',true,false],['reduced',true,true]]){
  const context=await browser.newContext({viewport:touch?{width:844,height:390}:{width:1280,height:720},hasTouch:touch,reducedMotion:reduced?'reduce':'no-preference',locale:'en-US',timezoneId:'America/New_York'});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('SOURCE ERROR',e.message);});page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('https://api.luminet.cn/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{"announcements":[]}'}));
  await page.goto(url+'/source/index.html');await page.waitForFunction(()=>typeof ATLAS_IMG!=='undefined'&&ATLAS_IMG?.width>0&&typeof G!=='undefined');
  const p=progression(1);
  await page.evaluate(async p=>{window.CloudSync.api=async()=>({run:{run_id:'run_progressiveSource1',generator_version:3,status:'active',mode:'endless',travelers:5,score:500,processed:5,correct:5,streak:5,best_streak:5,strikes:0,multiplier:1.5,progression:p},item:null});await Endless.resume();goScene('booth');},p);
  const click=async(target,x,y)=>{const b=await target.locator('#game').boundingBox();if(touch)await page.touchscreen.tap(b.x+x*b.width/640,b.y+y*b.height/360);else await page.mouse.click(b.x+x*b.width/640,b.y+y*b.height/360);};
  await page.screenshot({path:path.join(out,name+'-source-unlock.png')});
  await click(page,528,330);await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>!!B.ruleInst.doc.fields.tz),true);
  assert.equal(await page.evaluate(()=>ConstitutionGuide.unread()),false);
  await page.screenshot({path:path.join(out,name+'-source-open.png')});
  // Keep the book open and drag position fixed when a fresh server stage arrives.
  await page.evaluate(p=>{B.ruleInst.x=350;B.ruleInst.y=130;ConstitutionGuide.sync({...Endless.run(),progression:p});Endless.run=()=>({generator_version:3,progression:p});ConstitutionGuide.update();},progression(2));
  assert.equal(await page.evaluate(()=>B.ruleInst.x===350&&B.ruleInst.y===130&&!!B.ruleInst.doc.fields.pay),true);
  await page.screenshot({path:path.join(out,name+'-source-already-open.png')});
  await context.close();
  // A fresh context isolates SDK storage and exercises the official packed IIFE.
  const pack=await browser.newContext({viewport:touch?{width:844,height:390}:{width:1280,height:720},hasTouch:touch,reducedMotion:reduced?'reduce':'no-preference',locale:'en-US',timezoneId:'America/New_York'});
  const pp=await pack.newPage();pp.on('pageerror',e=>{errors.push(e.message);console.log('IIFE ERROR',e.message);});pp.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await pp.goto(url);
  let frame=pp.frames().find(f=>f.url().endsWith('/frame'));await frame.locator('#host-shell').waitFor({state:'hidden'});await frame.getByRole('button',{name:'Got it',exact:true}).click();
  const tap=async(x,y)=>{const b=await frame.locator('#game').boundingBox();if(touch)await pp.touchscreen.tap(b.x+x*b.width/640,b.y+y*b.height/360);else await pp.mouse.click(b.x+x*b.width/640,b.y+y*b.height/360);};
  await tap(480,155);await pp.waitForTimeout(1200);await tap(320,250);await pp.waitForTimeout(2800);
  await pp.evaluate(p=>{preview.run={...run('endless'),run_id:'run_progressivePacked1',generator_version:3,travelers:5,progression:p};},progression(1));
  await frame.waitForFunction(()=>{const p=document.querySelector('#game').getContext('2d').getImageData(335,300,1,1).data;return p[0]>40&&p[0]>p[1]*1.4;});await tap(420,304);await pp.waitForTimeout(400);await pp.screenshot({path:path.join(out,name+'-iife-lobby.png')});await frame.getByRole('button',{name:'Continue',exact:true}).click();await pp.waitForTimeout(2100);
  const nextCount=()=>pp.evaluate(()=>preview.calls.filter(c=>c.method==='http'&&c.args[1]?.json?.op==='run_next').length);
  const before=await nextCount();await tap(15,298);await pp.waitForTimeout(100);assert.equal(await nextCount(),before);
  await pp.screenshot({path:path.join(out,name+'-iife-unlock.png')});
  await tap(528,330);await pp.waitForTimeout(250);await pp.screenshot({path:path.join(out,name+'-iife-open.png')});
  assert.equal(await pp.evaluate(()=>Object.keys(localStorage).some(k=>k.includes('ip-please-endless-rules-v3')&&k.includes('run_progressivePacked1'))),true);
  // Read acknowledgement survives an actual iframe reload and reconnect.
  await pp.reload();frame=pp.frames().find(f=>f.url().endsWith('/frame'));await frame.locator('#host-shell').waitFor({state:'hidden'});
  await tap(480,155);await pp.waitForTimeout(1200);await tap(320,250);await pp.waitForTimeout(2800);
  await pp.evaluate(p=>{preview.run={...run('endless'),run_id:'run_progressivePacked1',generator_version:3,travelers:5,progression:p};},progression(1));
  await frame.waitForFunction(()=>{const p=document.querySelector('#game').getContext('2d').getImageData(335,300,1,1).data;return p[0]>40&&p[0]>p[1]*1.4;});await tap(420,304);await pp.waitForTimeout(400);await pp.screenshot({path:path.join(out,name+'-iife-lobby.png')});await frame.getByRole('button',{name:'Continue',exact:true}).click();await pp.waitForTimeout(2100);await tap(15,298);await pp.waitForTimeout(300);
  assert.equal(await nextCount(),1,'acknowledged reload dispatches');
  await pp.screenshot({path:path.join(out,name+'-iife-reconnected.png')});
  assert.deepEqual(errors,[]);await pack.close();console.log(name+': source and opaque IIFE pointer/touch unlock, book page, already-open position, reload acknowledgement; no JS/CSP errors');
 }
 } finally {if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
