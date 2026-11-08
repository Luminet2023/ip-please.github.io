const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createMiniAppHost}=require('../../game-host');
const {JSDOM,VirtualConsole}=require('../../tests/frontend/node_modules/jsdom');
const save='ip-please-file-zero-save-v1',endings='ip-please-file-zero-endings-v1',last='ip-please-file-zero-last-ending-v1';
const local={day:8,plot:{}},user={user_id:'user_guesttest00000001',linuxdo_id:'42',display_name:'Same name'};
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let id=null,fail=false,cloud=null,lose=false;const disk=new Map(),calls=[];
 const sdk={ready:Promise.resolve(),theme:{get:async()=>({locale:'en'})},user:{getCurrent:async()=>id?{id,username:'same'}:null,getById:async()=>{throw Error('guest lookup');}},
 localStorage:{exportData:async()=>({format:1,entries:[...disk]}),importData:async({entries})=>{if(fail)throw Error('quota');for(const [k,v]of entries)disk.set(k,v);}},
 http:{request:async(name,o)=>{calls.push({name,o});const account={...user,user_id:id===42?user.user_id:'user_guesttest00000002',linuxdo_id:String(id)};
 if(name==='bootstrap')return {status:200,body:{user:account,channel:'sandbox'}};if(name==='profile')return {status:200,body:account};
 if(name==='query')return cloud?{status:200,body:cloud}:{status:404,body:{detail:'The requested resource was not found.'}};
 if(name==='action'){const a=o.json.args;if(a.base_version!==(cloud?.version||0))return {status:409,body:{detail:'The cloud save has a newer version than the client base version.'}};cloud={payload:a.payload,day:a.day,version:1};if(lose){lose=false;throw Error('lost');}return {status:200,body:cloud};}throw Error(name);}}};
 return {sdk,disk,calls,login:n=>id=n,fail:v=>fail=v,lose:()=>lose=true,cloud:v=>cloud=v};
}
async function cloudRuntime(t,host){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM('<div id="cloud-overlay" hidden></div><div id="cloud-panel" hidden></div><button id="cloud"></button><div id="toast"></div>',{url:'https://guest.test',virtualConsole:vc});await turn();
 const rt=require('../../tools/test_runtime')(17);rt.sandbox.document=dom.window.document;rt.sandbox.addEventListener=()=>{};rt.sandbox.GameHost=host;Object.assign(rt.sandbox.localStorage,host.storage);rt.run(fs.readFileSync(path.resolve(__dirname,'../../cloud.js'),'utf8'));await turn();await turn();
 t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);});return {...rt,dom};
}
test('null SDK profile boots guest with durable story/endings and no HTTP or credentials',async t=>{
 const p=fixture(),h=await createMiniAppHost(p.sdk);assert.equal(h.user,null);assert.equal(h.isGuest,true);
 h.storage.setItem(save,JSON.stringify(local));h.storage.setItem(endings,'["E30"]');await h.flush();
 const again=await createMiniAppHost(p.sdk);assert.deepEqual(JSON.parse(again.storage.getItem(save)),local);assert.equal(again.storage.getItem(endings),'["E30"]');
 const rt=await cloudRuntime(t,again);assert.equal(rt.sandbox.CloudSync.isLoggedIn(),false);await rt.sandbox.CloudSync.onDayEnd(local);await rt.sandbox.CloudSync.onGameEnd(local);assert.equal(p.calls.length,0);assert.equal(rt.dom.window.document.querySelector('#toast').textContent,'');
 await assert.rejects(again.request('/endless/runs',{method:'POST',body:{mode:'endless'}}),/sign in/i);assert.equal(p.calls.length,0);assert.throws(()=>again.storage.setItem('auth-token','secret'),/credential/i);
});
test('guest login waits for durable progress before identity reload notification',async()=>{
 const p=fixture(),h=await createMiniAppHost(p.sdk);h.storage.setItem(save,JSON.stringify(local));p.fail(true);p.login(42);
 await assert.rejects(h.checkIdentity(),/quota/);assert.equal(h.identityChanged,false);assert.equal(h.storage.getItem(save),JSON.stringify(local));
 p.fail(false);await assert.rejects(h.checkIdentity(),/account/i);assert.equal(h.identityChanged,true);assert.equal(h.loginDetected,true);
 const account=await createMiniAppHost(p.sdk);assert.equal(account.storage.getItem(save),JSON.stringify(local));assert.equal(account.guestTransfer().payload.day,8);
});
test('login automatically uploads guest immediately; durable journal clears transfer once and other accounts cannot inherit it',async t=>{
 const p=fixture(),g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify(local));g.storage.setItem(endings,'["E01","E30"]');await g.flush();p.login(42);
 const h=await createMiniAppHost(p.sdk);await cloudRuntime(t,h);await h.flush();
 const actions=p.calls.filter(c=>c.name==='action');assert.equal(actions.length,1);assert.equal(actions[0].o.json.args.base_version,0);assert.equal(actions[0].o.json.args.payload.day,8);assert.equal(h.guestTransfer(),null);
 const again=await createMiniAppHost(p.sdk);assert.equal(again.guestTransfer(),null);assert.equal(again.storage.getItem(endings),'["E01","E30"]');p.login(43);const other=await createMiniAppHost(p.sdk);assert.equal(other.storage.getItem(save),null);assert.equal(other.guestTransfer(),null);
});
test('completed guest ending is promoted and cloud conflict waits for explicit choice',async t=>{
 const p=fixture(),g=await createMiniAppHost(p.sdk);g.storage.setItem(last,JSON.stringify({day:14,plot:{final:{ending:'E30'}}}));g.storage.setItem(endings,'["E30"]');await g.flush();p.cloud({day:2,version:7,payload:{day:2,plot:{}}});p.login(42);
 const h=await createMiniAppHost(p.sdk),rt=await cloudRuntime(t,h);await turn();assert.equal(p.calls.filter(c=>c.name==='action').length,1);assert.equal(h.pending().length,1);assert.match(rt.dom.window.document.querySelector('.dialog').textContent,/冲突/);
 const buttons=[...rt.dom.window.document.querySelectorAll('.dialog button')];buttons.find(b=>b.textContent==='用云端存档').click();await turn();await h.flush();assert.equal(h.pending().length,0);assert.equal(JSON.parse(h.storage.getItem(save)).day,2);assert.equal(h.storage.getItem(endings),'["E30"]');
});
test('existing unsynced account progress gets explicit guest choice before any upload',async t=>{
 const p=fixture();p.login(42);const a=await createMiniAppHost(p.sdk);a.storage.setItem(save,JSON.stringify({day:3,plot:{}}));await a.flush();p.login(null);const g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify(local));await g.flush();p.login(42);
 const h=await createMiniAppHost(p.sdk);assert.equal(JSON.parse(h.storage.getItem(save)).day,3);const rt=await cloudRuntime(t,h);assert.equal(p.calls.filter(c=>c.name==='action').length,0);assert.match(rt.dom.window.document.querySelector('.dialog').textContent,/访客/);
 [...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='使用访客进度').click();await turn();await turn();await h.flush();assert.equal(p.calls.filter(c=>c.name==='action')[0].o.json.args.payload.day,8);
});
test('failed account copy retains unclaimed guest; lost upload reopens original envelope without a second transfer',async()=>{
 const p=fixture(),g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify(local));await g.flush();p.login(42);p.fail(true);await assert.rejects(createMiniAppHost(p.sdk),/quota/);p.fail(false);
 const h=await createMiniAppHost(p.sdk);assert.equal(h.guestTransfer().payload.day,8);p.lose();await assert.rejects(h.request('/sync/save',{method:'POST',body:{day:8,payload:local,base_version:0}}));
 const first=h.pending()[0];const reopened=await createMiniAppHost(p.sdk);assert.equal(reopened.guestTransfer(),null);assert.deepEqual(reopened.pending()[0],first);assert.equal(reopened.storage.getItem(save),JSON.stringify(local));
});
test('guest actual day and ending callbacks retain durable barriers without login prompts',async t=>{
 const p=fixture(),h=await createMiniAppHost(p.sdk),rt=await cloudRuntime(t,h);rt.run('newGame();startDay();S.savings=100;scene="summary";now=10;sceneT0=0;initSummary();');
 p.fail(true);rt.run('summaryClick(...center(CONTINUE_BTN));');await turn();assert.equal(rt.run('scene'),'summary');p.fail(false);await h.retryTransition();assert.equal(rt.run('scene'),'daycard');
 p.fail(true);rt.run("commitEnding('E30')");await turn();assert.equal(rt.run('scene'),'daycard');p.fail(false);await h.retryTransition();assert.equal(rt.run('scene'),'ending');await turn();assert.equal(p.calls.length,0);
 const again=await createMiniAppHost(p.sdk);assert.equal(again.storage.getItem(save),null);assert.equal(JSON.parse(again.storage.getItem(last)).plot.final.ending,'E30');
});
test('current SDK legacy channel records remain readable and writes migrate to shared records',async()=>{
 const p=fixture();p.login(42);const old='ip-please:account:'+user.user_id+':v2:sandbox:key:'+encodeURIComponent(save);p.disk.set(old,JSON.stringify(JSON.stringify(local)));
 const h=await createMiniAppHost(p.sdk);assert.equal(h.storage.getItem(save),JSON.stringify(local));h.storage.removeItem(save);await h.flush();assert.equal(p.disk.get(old),JSON.stringify(JSON.stringify(local)));assert.equal((await createMiniAppHost(p.sdk)).storage.getItem(save),null);
});
test('existing account pending receipt recovers before the deferred guest choice',async t=>{
 const p=fixture();p.login(42);const a=await createMiniAppHost(p.sdk);a.storage.setItem(save,JSON.stringify({day:3,plot:{}}));await a.flush();
 const http=p.sdk.http.request;p.sdk.http.request=async(n,o)=>n==='action'?Promise.reject(Error('offline')):http(n,o);
 await assert.rejects(a.request('/sync/save',{method:'POST',body:{day:3,payload:{day:3,plot:{}},base_version:0}}));p.login(null);const g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify(local));await g.flush();p.login(42);p.sdk.http.request=http;
 const h=await createMiniAppHost(p.sdk),rt=await cloudRuntime(t,h);assert.equal(rt.dom.window.document.querySelector('.dialog'),null);
 const recovered=await rt.sandbox.CloudSync.recoverPending();await turn();assert.equal(h.pending().length,0);assert.equal(recovered.blocked,true);assert.match(rt.dom.window.document.querySelector('.dialog').textContent,/访客/);
});
test('choosing completed guest story removes the old resumable account slot durably',async()=>{
 const p=fixture();p.login(42);const a=await createMiniAppHost(p.sdk);a.storage.setItem(save,JSON.stringify({day:3,plot:{}}));await a.flush();p.login(null);const g=await createMiniAppHost(p.sdk);g.storage.setItem(last,JSON.stringify({day:14,plot:{final:{ending:'E30'}}}));g.storage.setItem(endings,'["E30"]');await g.flush();p.login(42);
 const h=await createMiniAppHost(p.sdk);assert.equal(h.guestTransfer().choice,true);await h.chooseGuestTransfer(true);assert.equal((await createMiniAppHost(p.sdk)).storage.getItem(save),null);
});
test('guest promotion uses base zero even when the account has synced metadata, preserving cloud choice',async t=>{
 const p=fixture();p.login(42);const a=await createMiniAppHost(p.sdk);a.storage.setItem(save,JSON.stringify({day:3,plot:{}}));a.storage.setItem('ip-please-sync-meta-v1:'+user.user_id,'{"version":1,"day":3}');await a.flush();p.cloud({day:3,version:1,payload:{day:3,plot:{}}});p.login(null);const g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify(local));await g.flush();p.login(42);
 const h=await createMiniAppHost(p.sdk),rt=await cloudRuntime(t,h);[...rt.dom.window.document.querySelectorAll('.dialog button')].find(b=>b.textContent==='使用访客进度').click();await turn();await turn();assert.equal(p.calls.filter(c=>c.name==='action')[0].o.json.args.base_version,0);assert.equal(h.pending().length,1);assert.match(rt.dom.window.document.querySelector('.dialog').textContent,/冲突/);
});
test('same claimed account can import a later guest revision while other accounts cannot claim its history',async()=>{
 const p=fixture(),g=await createMiniAppHost(p.sdk);g.storage.setItem(save,JSON.stringify({day:2,plot:{}}));await g.flush();p.login(42);const a=await createMiniAppHost(p.sdk);await a.request('/sync/save',{method:'POST',body:{day:2,payload:{day:2,plot:{}},base_version:0}});
 assert.equal((await createMiniAppHost(p.sdk)).guestTransfer(),null);p.login(null);const preference=await createMiniAppHost(p.sdk);preference.storage.setItem('ip-please-file-zero-lang','ja');await preference.flush();p.login(42);assert.equal((await createMiniAppHost(p.sdk)).guestTransfer(),null);p.login(null);const later=await createMiniAppHost(p.sdk);later.storage.setItem(save,JSON.stringify(local));await later.flush();p.login(43);assert.equal((await createMiniAppHost(p.sdk)).guestTransfer(),null);
 p.login(42);const returning=await createMiniAppHost(p.sdk);assert.equal(returning.guestTransfer()?.payload.day,8);
});
