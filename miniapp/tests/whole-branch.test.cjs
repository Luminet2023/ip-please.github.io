const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createMiniAppHost}=require('../../game-host');
const {JSDOM,VirtualConsole}=require('../../tests/frontend/node_modules/jsdom');
const root=path.resolve(__dirname,'../..');
const turn=()=>new Promise(r=>setImmediate(r));
const saveKey='ip-please-file-zero-save-v1', endingsKey='ip-please-file-zero-endings-v1';
const user={user_id:'user_reviewabcdefghijkl',linuxdo_id:'42',display_name:'Review'};
function platform(){
 const disk=new Map();let beforeWrite=async()=>{},action=async()=>{throw Error('offline');},query=async()=>({status:404,body:{detail:'The requested resource was not found.'}});
 const sdk={ready:Promise.resolve(),user:{getCurrent:async()=>({id:42,username:'review'})},theme:{get:async()=>({locale:'en'})},
 localStorage:{getItem:async k=>disk.get(k)||null,setItem:async(k,v)=>{await beforeWrite([[k,v]]);disk.set(k,v);},exportData:async()=>({format:1,entries:[...disk]}),importData:async s=>{assert.equal(s.format,1);await beforeWrite(s.entries);for(const [k,v] of s.entries)disk.set(k,v);return null;}},
 http:{request:async(n,o)=>n==='bootstrap'?{status:200,body:{channel:'sandbox',user}}:n==='profile'?{status:200,body:user}:n==='action'?action(o.json):query(o.query)}};
 return {sdk,disk,setWrite:fn=>beforeWrite=fn,setAction:fn=>action=fn,setQuery:fn=>query=fn};
}
test('stale second host changing language cannot erase save, endings or pending request',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk),b=await createMiniAppHost(p.sdk);
 a.storage.setItem(saveKey,'{"day":7}');a.storage.setItem(endingsKey,'["E23"]');await a.flush();
 await assert.rejects(a.request('/sync/save',{method:'POST',body:{day:7,payload:{day:7},base_version:0}}));
 b.storage.setItem('ip-please-lang','ja');await b.flush();const c=await createMiniAppHost(p.sdk);
 assert.equal(c.storage.getItem(saveKey),'{"day":7}');assert.deepEqual(JSON.parse(c.storage.getItem(endingsKey)),['E23']);assert.equal(c.pending().length,1);assert.equal(c.storage.getItem('ip-please-lang'),'ja');
});
test('truly concurrent host commits union endings and independently preserve save and preference',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk),b=await createMiniAppHost(p.sdk);const releases=[];
 p.setWrite(()=>new Promise(r=>releases.push(r)));
 a.storage.setItem(saveKey,'{"day":7}');a.storage.setItem(endingsKey,'["E23"]');b.storage.setItem('ip-please-lang','ja');b.storage.setItem(endingsKey,'["E24"]');
 const writes=[a.flush(),b.flush()];await turn();assert.equal(releases.length,2);releases[1]();await turn();releases[0]();await Promise.all(writes);
 const c=await createMiniAppHost(p.sdk);assert.equal(c.storage.getItem(saveKey),'{"day":7}');assert.equal(c.storage.getItem('ip-please-lang'),'ja');assert.deepEqual(JSON.parse(c.storage.getItem(endingsKey)).sort(),['E23','E24']);
});
test('concurrent pending creation survives another request acknowledgement and stale replay never resurrects ack',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk),b=await createMiniAppHost(p.sdk);let releaseA,releaseB;const sent=[];
 p.setAction(r=>{sent.push(r);return new Promise(resolve=>{if(r.args.day===7)releaseA=resolve;else releaseB=resolve;});});
 const pa=a.request('/sync/save',{method:'POST',body:{day:7,payload:{day:7},base_version:1}}),pb=b.request('/sync/save',{method:'POST',body:{day:8,payload:{day:8},base_version:2}});
 await turn();assert.equal(sent.length,2);releaseB({status:200,body:{version:3,day:8,save_id:'save_reviewabcdefghijkl'}});await pb;
 releaseA({status:200,body:{version:2,day:7,save_id:'save_reviewabcdefghijkm'}});await pa;
 const c=await createMiniAppHost(p.sdk);assert.equal(c.pending().length,0);assert.equal(JSON.parse(c.storage.getItem('ip-please-sync-meta-v1:'+user.user_id)).version,3);
 // A duplicate original write can arrive after its ack; the ack must still dominate.
 const records=[...p.disk].filter(([k,v])=>v.includes(sent[0].request_id));
 for(const [k,v] of records)p.disk.set(k,v);
 assert.equal((await createMiniAppHost(p.sdk)).pending().length,0);
});
test('old blob migrates read-only, tombstone survives stale preference flush, account/channel isolate',async()=>{
 const p=platform(),scope='ip-please:account:'+user.user_id,old=JSON.stringify({[saveKey]:'{"day":3}',[endingsKey]:'["E01"]','ip-please-lang':'en'});p.disk.set(scope,old);
 const a=await createMiniAppHost(p.sdk),b=await createMiniAppHost(p.sdk);a.storage.removeItem(saveKey);await a.flush();b.storage.setItem('ip-please-lang','ja');await b.flush();
 assert.equal(p.disk.get(scope),old);const c=await createMiniAppHost(p.sdk);assert.equal(c.storage.getItem(saveKey),null);assert.deepEqual(JSON.parse(c.storage.getItem(endingsKey)),['E01']);
});
async function runtime(t,p){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM('<div id="cloud-overlay" hidden></div><div id="cloud-panel" hidden></div><button id="cloud"></button><div id="toast"></div>',{url:'https://review.test',virtualConsole:vc});await turn();
 const rt=require('../../tools/test_runtime')(17);rt.sandbox.document=dom.window.document;rt.sandbox.addEventListener=()=>{};rt.sandbox.GameHost=await createMiniAppHost(p.sdk);Object.assign(rt.sandbox.localStorage,rt.sandbox.GameHost.storage);
 t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);});return {...rt,dom,host:rt.sandbox.GameHost};
}
for(const entry of ['resume','start','openLobby','resync','retryPending'])test(entry+' blocks on recovered story conflict until explicit local choice',async t=>{
 const p=platform();const local={day:2,plot:{}},remote={day:7,plot:{}};const calls=[];let offline=true;
 p.setAction(async r=>{calls.push(r);if(offline)throw Error('offline');return r.args.base_version===3?{status:200,body:{version:4,day:2}}:{status:409,body:{detail:'The cloud save has a newer version than the client base version.'}};});
 p.setQuery(async q=>q.op==='save'?{status:200,body:{payload:remote,day:7,version:3,updated_at:'2026-11-08T00:00:00Z'}}:q.op==='daily'?{status:200,body:{played:false,travelers:40}}:{status:200,body:{run:{run_id:'run_reviewabcdefghijkl',status:'active',generator_version:2},item:null}});
 const rt=await runtime(t,p);await assert.rejects(rt.host.request('/sync/save',{method:'POST',body:{day:2,payload:local,base_version:1}}));offline=false;rt.run(fs.readFileSync(path.join(root,'cloud.js'),'utf8'));
 if(entry==='retryPending')await rt.sandbox.CloudSync.retryPending();else if(entry==='resync'){rt.run('newGame();startDay();');rt.sandbox.Endless.settle({outcomePromise:Promise.reject(Error('offline'))});await turn();[...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='重试').click();await turn();await turn();}else await rt.sandbox.Endless[entry]('endless');
 await turn();assert.match(rt.dom.window.document.querySelector('.dialog')?.textContent||'',/云存档冲突/);assert.notEqual(rt.run('scene'),'daycard');assert.equal(rt.host.pending().length,1);
 await rt.sandbox.Endless.start('endless');await rt.sandbox.Endless.openLobby();assert.match(rt.dom.window.document.querySelector('.dialog').textContent,/云存档冲突/);assert.ok(calls.every(r=>r.op==='save'));
 const keep=[...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='保留本机');keep.click();await turn();await turn();assert.equal(rt.host.pending().length,0);assert.equal(calls.at(-1).args.base_version,3);assert.notEqual(calls.at(-1).request_id,calls[0].request_id);
});
for(const version of [1,2])for(const op of ['decision','waves/wave_reviewabcdefghijkl/result','abandon'])test('v'+version+' recovered terminal '+op+' displays final stats/rank without current run',async t=>{
 const p=platform();let offline=true;const final={score:100,travelers:3,processed:3,correct:1,best_streak:1,document_reviews:3,model_identity_checks:1,ranks:{endless:1}};
 p.setAction(async()=>{if(offline)throw Error('lost response');return {status:200,body:{run:{run_id:'run_reviewabcdefghijkl',status:'ended',generator_version:version,score:100},final}};});
 const rt=await runtime(t,p);await assert.rejects(rt.host.request('/endless/runs/run_reviewabcdefghijkl/'+op,{method:'POST',body:{entrant_id:'ent_reviewabcdefghijkl',decision:'approve'}}));offline=false;rt.run(fs.readFileSync(path.join(root,'cloud.js'),'utf8'));
 await rt.sandbox.CloudSync.retryPending();await turn();assert.equal(rt.run('scene'),'eover');assert.deepEqual(rt.sandbox.Endless.final(),final);assert.equal(rt.host.pending().length,0);
});
test('ack concurrent with a new request never erases it, and a delayed original journal write cannot resurrect the ack',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk),b=await createMiniAppHost(p.sdk);let doneA,doneB;
 p.setAction(r=>new Promise(resolve=>{if(r.args.day===2)doneA=resolve;else doneB=resolve;}));
 const pa=a.request('/sync/save',{method:'POST',body:{day:2,payload:{day:2},base_version:0}});await turn();
 const originalSnapshot={format:1,entries:[...p.disk]};
 let releaseAck,releaseNew;
 p.setWrite(entries=>new Promise(resolve=>{if(entries.some(([k])=>k.includes('ack:')))releaseAck=resolve;else releaseNew=resolve;}));
 doneA({status:200,body:{version:1,day:2}});
 const pb=b.request('/sync/save',{method:'POST',body:{day:3,payload:{day:3},base_version:1}});await turn();
 assert.equal(typeof releaseAck,'function');assert.equal(typeof releaseNew,'function');releaseAck();await pa;releaseNew();await turn();
 const c=await createMiniAppHost(p.sdk);assert.equal(c.pending().length,1);assert.equal(c.pending()[0].args.day,3);
 p.setWrite(async()=>{});await p.sdk.localStorage.importData(originalSnapshot);
 const d=await createMiniAppHost(p.sdk);assert.equal(d.pending().length,1);assert.equal(d.pending()[0].args.day,3);
 doneB({status:200,body:{version:2,day:3}});await pb;
});
test('legacy journal replays exact ID and metadata without writing its account blob',async()=>{
 const p=platform(),scope='ip-please:account:'+user.user_id;
 const envelope={request_id:'req_reviewabcdefghijkl',op:'save',args:{day:2,payload:{day:2},base_version:4}};
 const blob=JSON.stringify({'pending-actions-v1':JSON.stringify([envelope]),['ip-please-sync-meta-v1:'+user.user_id]:JSON.stringify({version:4,day:1})});p.disk.set(scope,blob);
 let sent;p.setAction(async r=>{sent=r;return {status:200,body:{version:5,day:2}};});
 const h=await createMiniAppHost(p.sdk);await h.retryPending();assert.deepEqual(sent,envelope);assert.equal(p.disk.get(scope),blob);
 const c=await createMiniAppHost(p.sdk);assert.equal(c.pending().length,0);assert.equal(JSON.parse(c.storage.getItem('ip-please-sync-meta-v1:'+user.user_id)).version,5);
});
test('save conflict survives reopen and cloud choice acknowledges only after explicit selection',async t=>{
 const p=platform(),local={day:2,plot:{}},remote={day:7,plot:{}};
 p.setAction(async()=>({status:409,body:{detail:'The cloud save has a newer version than the client base version.'}}));
 p.setQuery(async()=>({status:200,body:{payload:remote,day:7,version:3,updated_at:'2026-11-08T00:00:00Z'}}));
 const first=await createMiniAppHost(p.sdk);await first.request('/sync/save',{method:'POST',body:{day:2,payload:local,base_version:1}});
 const rt=await runtime(t,p);let reloads=0;rt.host.reload=()=>reloads++;rt.run(fs.readFileSync(path.join(root,'cloud.js'),'utf8'));
 await rt.sandbox.Endless.resume();assert.equal(rt.host.pending().length,1);
 [...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='用云端存档').click();await turn();await turn();
 assert.equal(reloads,1);const next=await createMiniAppHost(p.sdk);assert.equal(next.pending().length,0);assert.deepEqual(JSON.parse(next.storage.getItem(saveKey)),remote);
});
test('known run ID recovers final settlement when terminal receipt omits final',async t=>{
 const p=platform(),final={score:200,ranks:{daily:2},document_reviews:4,model_identity_checks:2};let offline=true;
 const run={run_id:'run_reviewabcdefghijkl',status:'ended',generator_version:1};
 p.setAction(async()=>{if(offline)throw Error('offline');return {status:200,body:{run}};});
 p.setQuery(async q=>{assert.equal(q.op,'run');assert.equal(q.run_id,run.run_id);return {status:200,body:{run,final}};});
 const rt=await runtime(t,p);await assert.rejects(rt.host.request('/endless/runs/'+run.run_id+'/abandon',{method:'POST'}));offline=false;rt.run(fs.readFileSync(path.join(root,'cloud.js'),'utf8'));
 await rt.sandbox.Endless.resume();assert.equal(rt.run('scene'),'eover');assert.deepEqual(rt.sandbox.Endless.final(),final);
});
test('two actual hosts replay one request with its journal delayed past the other acknowledgement',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk);await assert.rejects(a.request('/sync/save',{method:'POST',body:{day:2,payload:{day:2},base_version:4}}));
 const b=await createMiniAppHost(p.sdk),id=a.pending()[0].request_id;let releaseB,blocked=false;const ids=[];
 p.setWrite(entries=>{if(!blocked && entries.some(([k])=>k.endsWith('request:'+id))){blocked=true;return new Promise(resolve=>releaseB=resolve);}return Promise.resolve();});
 p.setAction(async r=>{ids.push(r.request_id);return {status:200,body:{version:5,day:2}};});
 const retryB=b.retryPending();await turn();assert.equal(typeof releaseB,'function');await a.retryPending();assert.equal((await createMiniAppHost(p.sdk)).pending().length,0);
 releaseB();await retryB;assert.deepEqual(ids,[id,id]);const c=await createMiniAppHost(p.sdk);assert.equal(c.pending().length,0);assert.equal(JSON.parse(c.storage.getItem('ip-please-sync-meta-v1:'+user.user_id)).version,5);
});
test('exported records isolate exact account and channel prefixes',async()=>{
 const p=platform(),a=await createMiniAppHost(p.sdk);a.storage.setItem(saveKey,'{"day":7}');await a.flush();
 const original=p.sdk.http.request;p.sdk.http.request=async(n,o)=>n==='bootstrap'?{status:200,body:{channel:'production',user}}:original(n,o);
 const production=await createMiniAppHost(p.sdk);assert.equal(production.storage.getItem(saveKey),null);production.storage.setItem('ip-please-lang','ja');await production.flush();
 const other={...user,user_id:user.user_id+'x'};p.sdk.http.request=async(n,o)=>n==='bootstrap'?{status:200,body:{channel:'sandbox',user:other}}:n==='profile'?{status:200,body:other}:original(n,o);
 const account=await createMiniAppHost(p.sdk);assert.equal(account.storage.getItem(saveKey),null);assert.equal(account.storage.getItem('ip-please-lang'),null);
 p.sdk.http.request=original;const reopened=await createMiniAppHost(p.sdk);assert.equal(reopened.storage.getItem(saveKey),'{"day":7}');assert.equal(reopened.storage.getItem('ip-please-lang'),null);
});
for(const status of [200,409])test('keep-local network failure invalidates old cloud choice and recovers replacement '+status,async t=>{
 const p=platform(),local={day:2,plot:{}},remote={day:7,plot:{}},calls=[];
 const conflict={status:409,body:{detail:'The cloud save has a newer version than the client base version.'}};
 p.setAction(async r=>{calls.push(r);if(calls.length===1)return conflict;if(calls.length===2)throw Error('offline after replacement');return status===409?conflict:{status:200,body:{version:4,day:2}};});
 p.setQuery(async()=>({status:200,body:{payload:remote,day:7,version:calls.length>=3?4:3,updated_at:'2026-11-08T00:00:00Z'}}));
 const rt=await runtime(t,p);let reloads=0;rt.host.reload=()=>reloads++;
 rt.host.storage.setItem(saveKey,JSON.stringify(local));await rt.host.flush();
 await rt.host.request('/sync/save',{method:'POST',body:{day:2,payload:local,base_version:1}});
 rt.run(fs.readFileSync(path.join(root,'cloud.js'),'utf8'));await rt.sandbox.Endless.resume();
 const buttons=[...rt.dom.window.document.querySelectorAll('.dialog button')],oldCloud=buttons.find(b=>b.textContent==='用云端存档');
 buttons.find(b=>b.textContent==='保留本机').click();await turn();await turn();
 const replacement=rt.host.pending()[0];assert.notEqual(replacement.request_id,calls[0].request_id);assert.equal(replacement.args.day,2);
 oldCloud.click();await turn();await turn();
 assert.equal(reloads,0,'an old cloud choice cannot reload while its replacement is unconfirmed');
 assert.deepEqual(JSON.parse(rt.host.storage.getItem(saveKey)),local);
 assert.equal(rt.dom.window.document.getElementById('cloud-overlay').hidden,true);
 assert.equal(rt.host.pending()[0].request_id,replacement.request_id);
 await rt.sandbox.CloudSync.retryPending();await turn();
 assert.equal(calls[2].request_id,replacement.request_id,'recover the original replacement envelope');
 if(status===409){
  const freshCloud=[...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='用云端存档');assert.ok(freshCloud);assert.notEqual(freshCloud,oldCloud);
  oldCloud.click();await turn();assert.equal(reloads,0);assert.equal(rt.host.pending()[0].request_id,replacement.request_id);
  freshCloud.click();await turn();await turn();assert.equal(reloads,1);assert.deepEqual(JSON.parse(rt.host.storage.getItem(saveKey)),remote);
 }else {assert.equal(reloads,0);assert.deepEqual(JSON.parse(rt.host.storage.getItem(saveKey)),local);}
 assert.equal(rt.host.pending().length,0);
});
