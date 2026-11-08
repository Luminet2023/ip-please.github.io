const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_CORE||'/home/luminet/.nvm/versions/node/v22.22.2/lib/node_modules/camoufox/node_modules/playwright-core');
const out=process.env.BROWSER_ARTIFACTS||'/tmp/ip-please-task3-browser';fs.mkdirSync(out,{recursive:true});
(async()=>{
 const {serve}=await import('../preview/server.mjs');const server=await serve(0);const url='http://127.0.0.1:'+server.address().port;
 let browser,checks=0;
 try{
 browser=await chromium.launch({headless:true});
 for(const [name,viewport,touch] of [['desktop',{width:1280,height:720},false],['phone',{width:844,height:390},true]]){
  if(process.env.BROWSER_ONLY && name!==process.env.BROWSER_ONLY)continue;
  const context=await browser.newContext({viewport,hasTouch:touch,locale:'en-US',timezoneId:'America/New_York'});const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url);let frame=page.frames().find(f=>f.url().endsWith('/frame'));
  await frame.locator('#host-shell').waitFor({state:'hidden'});await frame.getByRole('button',{name:'Got it',exact:true}).click();
  const click=async(x,y)=>{const b=await frame.locator('#game').boundingBox();if(touch)await page.touchscreen.tap(b.x+x*b.width/640,b.y+y*b.height/360);else await page.mouse.click(b.x+x*b.width/640,b.y+y*b.height/360);};
  await click(480,155);await page.waitForTimeout(1200);await click(320,250);await page.waitForTimeout(1800);
  await page.screenshot({path:path.join(out,name+'-title.png')});
  await click(65,338);await page.waitForTimeout(400);await page.screenshot({path:path.join(out,name+'-gallery.png')});await click(5,200);await page.waitForTimeout(1800);
  await frame.locator('#cloud').click();await frame.locator('#cloud-panel').waitFor({state:'visible'});
  assert.match(await frame.locator('#cloud-panel').innerText(),/File Zero/);assert.match(await frame.locator('#cloud-panel').innerText(),/sandbox/);
  await frame.locator('.credit a').first().click();await frame.getByRole('button',{name:'Save history',exact:true}).click();await frame.locator('#cloud-overlay').getByRole('button',{name:'Close',exact:true}).click();
  await frame.locator('#cloud-panel').getByRole('button',{name:'Close',exact:true}).click();
  await frame.locator('#full').click();await frame.locator('#mute').click();await page.waitForTimeout(400);
  await click(390,304);await frame.locator('#cloud-overlay').getByRole('button',{name:'Leaderboard',exact:true}).click();
  await frame.locator('.board li').first().waitFor();assert.match(await frame.locator('.dialog h2').innerText(),/LINUX DO sandbox/);await frame.locator('.board img').waitFor();
  await frame.getByRole('button',{name:'This week',exact:true}).click();await frame.locator('.board li').first().waitFor();
  await page.screenshot({path:path.join(out,name+'-leaderboard.png')});
  await frame.locator('#cloud-overlay').getByRole('button',{name:'Close',exact:true}).click();await page.waitForTimeout(350);await click(390,304);
  await frame.locator('#cloud-overlay').getByRole('button',{name:'ENDLESS',exact:true}).click();await page.waitForTimeout(2300);
  await click(15,298);await page.waitForTimeout(4200);
  const cdp=touch?await context.newCDPSession(page):null;
  const drag=async(x1,y1,x2,y2)=>{
    const b=await frame.locator('#game').boundingBox();const point=(x,y)=>({x:b.x+x*b.width/640,y:b.y+y*b.height/360});const a=point(x1,y1),z=point(x2,y2);
    if(touch){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+(z.x-a.x)*i/8,y:a.y+(z.y-a.y)*i/8,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
    else {await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(z.x,z.y,{steps:8});await page.mouse.up();}
  };
  await drag(54,270,470,185);await click(633,224);await page.waitForTimeout(400);await click(512,224);await page.waitForTimeout(800);
  await page.screenshot({path:path.join(out,name+'-stamped.png')});await drag(470,185,100,270);await page.waitForTimeout(1600);
  await page.screenshot({path:path.join(out,name+'-endless.png')});
  const calls=await page.evaluate(()=>preview.calls);
  assert.ok(calls.some(c=>c.method==='http'&&c.args[0]==='action'&&c.args[1].json.op==='run_start'));
  assert.ok(calls.some(c=>c.method==='http'&&c.args[0]==='action'&&c.args[1].json.op==='run_next'));
  assert.ok(calls.some(c=>c.method==='http'&&c.args[0]==='action'&&c.args[1].json.op==='run_decision'&&c.args[1].json.args.decision==='approve'));
  assert.ok(calls.some(c=>c.method==='full'));assert.ok(calls.some(c=>c.method==='link'));
  assert.deepEqual(calls.filter(c=>c.method==='lookup').map(c=>c.args[0]),[42]);
  // Return through a real reload; SDK mirror retains chosen locale. Story remains available alongside cloud runs.
  await page.reload();frame=page.frames().find(f=>f.url().endsWith('/frame'));await frame.locator('#host-shell').waitFor({state:'hidden'});
  await click(480,155);await page.waitForTimeout(1200);await click(320,250);await page.waitForTimeout(1800);await click(250,304);await page.waitForTimeout(2800);await click(320,250);await page.waitForTimeout(1000);
  await page.screenshot({path:path.join(out,name+'-story.png')});
  const runtime=require('../../tools/test_runtime')(7);runtime.run('newGame();S.day=2;');const saved=JSON.parse(runtime.run('JSON.stringify(S)'));
  await page.evaluate(payload=>{preview.cloud={user_id:'user_preview0000000001',save_id:'save_preview000000001',version:1,day:2,updated_at:'2026-11-08T00:00:00.000Z',payload};},saved);
  await frame.locator('#cloud').click();await frame.locator('#cloud-panel').getByRole('button',{name:'Restore from cloud',exact:true}).click();
  await frame.locator('#cloud-overlay').getByRole('button',{name:'Load cloud save',exact:true}).click();await page.waitForTimeout(1200);
  frame=page.frames().find(f=>f.url().endsWith('/frame'));await frame.locator('#host-shell').waitFor({state:'hidden'});
  await click(480,155);await page.waitForTimeout(1200);await click(320,250);await page.waitForTimeout(1800);await page.screenshot({path:path.join(out,name+'-saved-title.png')});
  await click(178,304);await page.waitForTimeout(2800);await click(320,250);await page.waitForTimeout(800);await page.screenshot({path:path.join(out,name+'-saved-day2.png')});
  assert.deepEqual(errors,[]);checks++;console.log(name+': real canvas language/title/gallery/story/endless, drag/stamp/return/server decision, cloud restore/reopen/day2, lazy avatar, SDK fullscreen/link passed');await context.close();
 }
 console.log(checks+' desktop/mobile scenarios; artifacts '+out);
 }finally{try{if(browser)await browser.close();}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
})().catch(e=>{console.error(e);process.exitCode=1;});
