// Source-faithful scene audit. This uses website globals only for fixture setup;
// packaged IIFE pointer/touch gameplay is independently tested by browser.cjs.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_CORE||'/home/luminet/.nvm/versions/node/v22.22.2/lib/node_modules/camoufox/node_modules/playwright-core');
const root=path.resolve(__dirname,'../..'),out=process.env.BROWSER_ARTIFACTS||'/tmp/ip-please-task4-browser';fs.mkdirSync(out,{recursive:true});
(async()=>{
 const server=http.createServer((req,res)=>{const p=new URL(req.url,'http://local').pathname;const file=path.resolve(root,'.'+(p==='/'?'/index.html':p));if(!file.startsWith(root+'/')){res.writeHead(403);return res.end();}fs.readFile(file,(e,b)=>{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.statusCode=e?404:200;res.end(e?'Not found':b);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.stack));
  // Network is irrelevant to this pure rendering audit; no fixture auth or scores.
  await page.route('https://api.luminet.cn/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{"announcements":[]}'}));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof ATLAS_IMG!=='undefined'&&ATLAS_IMG?.width>0&&typeof G!=='undefined');
  await page.evaluate(()=>{window.requestAnimationFrame=()=>0;});await page.waitForTimeout(100);
  for(const language of ['zh','zh-hant','en','ja']){
   await page.evaluate(l=>{chooseLang(l);newGame();startDay();scene='booth';},language);
   const audit=await require('../../tools/browser_cast_audit')({page,out,language});assert.equal(audit.checks.length,88);
   const report=await page.evaluate(language=>{
    chooseLang(language);newGame();S.day=7;S.endless=true;Endless.run=()=>({generator_version:2,inspection_date:'2026.10.25'});scene='booth';startDay();
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=480;const ctx=canvas.getContext('2d');ctx.fillStyle='#24211f';ctx.fillRect(0,0,1280,480);const saved=G;setCtx(ctx);const checks=[];
    const permit=new EntryPermit({holder:'TAN-WATANABE, ALEXANDER WEI MING',purpose:'research',exp:'2026.10.24'});
    const device=device2('192.0.2.123','美国 · 旧金山','America/Los_Angeles','en-US','MacBook Pro');
    const registry=new Rulebook(7);registry.page=registry.pages.findIndex(p=>p.fields.registry);
    const docs=[['ep',permit],['dv',device],['rule',registry]];
    let x=10;for(const [key,doc] of docs){doc.draw(x,20);if(doc.layout)for(const row of doc.layout){if(8+tw(row.label,10)+6>doc.valueX)throw Error('Label overlaps value '+language);for(const line of row.lines)if(tw(line,row.size)>doc.w-doc.valueX-8)throw Error('Value overflow '+language);}
      B.docs=[{key,owner:'ent',big:true,x:230,y:130,doc}];doc.draw(230,130);
      for(const [name,f] of Object.entries(doc.fields)){const hit=fieldAt(230+(f[0]+f[2])/2,130+(f[1]+f[3])/2);if(hit?.key!==key+'.'+name)throw Error('Hit target '+key+'.'+name);checks.push(key+'.'+name);}
      x+=doc.w+18;
    }
    // Dedicated screenshot sheet avoids fixture docs painted over one another above.
    ctx.fillStyle='#24211f';ctx.fillRect(0,0,1280,480);x=10;for(const [,doc]of docs){doc.draw(x,20);x+=doc.w+18;}
    setCtx(saved);return {checks,image:canvas.toDataURL('image/png')};
   },language);
   fs.writeFileSync(path.join(out,language+'-long-documents.png'),Buffer.from(report.image.split(',')[1],'base64'));delete report.image;
   fs.writeFileSync(path.join(out,language+'-hitboxes.json'),JSON.stringify(report,null,2));
   console.log(language+': 88 portrait/expression transparency checks, long translated documents, '+report.checks.length+' real fieldAt targets');
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
