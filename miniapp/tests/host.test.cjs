const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const file = require('node:path').resolve(__dirname, '../../game-host.js');
const api = fs.existsSync(file) ? require(file) : {};
const response = (status, body, headers={}) => ({status,body,headers});
function platform() {
  const disk = new Map(); const calls = []; let fail = false; let id=42;
  const sdk = {ready:Promise.resolve(), user:{getCurrent:async()=>({id,username:'tester',name:'Test'}), getById:async n=>({id:n,avatarUrl:'blob:test'})},
    theme:{get:async()=>({locale:'ja'})}, lifecycle:{ready:async()=>{}},
    localStorage:{getItem:async k=>disk.get(k)||null,setItem:async(k,v)=>{if(fail)throw Error('quota');disk.set(k,v);}},
    http:{request:async(name, opts)=>{calls.push({name,opts}); if(name==='bootstrap')return response(200,{user:{user_id:'user_abcdefghijklmnop',linuxdo_id:'42',display_name:'Test'},channel:'sandbox',announcements:[],daily:{},active_run:null});if(name==='profile')return response(200,{user_id:'user_abcdefghijklmnop',linuxdo_id:'42',display_name:'Test'});return response(200,{version:1});}}};
  return {sdk,disk,calls,fail: v=>fail=v,account: v=>id=v};
}
test('storage is prehydrated, scoped, durable and retains dirty writes on failure', async()=>{
 assert.equal(typeof api.createMiniAppHost,'function'); const p=platform();
 const h=await api.createMiniAppHost(p.sdk);h.storage.setItem('save','one');p.fail(true);
 await assert.rejects(h.flush()); assert.equal(h.storage.getItem('save'),'one');
 p.fail(false);await h.flush(); const reopened=await api.createMiniAppHost(p.sdk);assert.equal(reopened.storage.getItem('save'),'one');
 p.sdk.http.request=async name=>response(200,name==='bootstrap'?{user:{user_id:'user_otheraccount1234',linuxdo_id:'43'},channel:'sandbox'}:{user_id:'user_otheraccount1234',linuxdo_id:'43'});p.account(43);
 const other=await api.createMiniAppHost(p.sdk);assert.equal(other.storage.getItem('save'),null);
 assert.throws(()=>other.storage.setItem('ip-please-auth-v2','secret'),/credential/i);
});
test('lost save response persists exact original ID and args across reopen',async()=>{
 assert.equal(typeof api.createMiniAppHost,'function');const p=platform();const orig=p.sdk.http.request;
 let lost=true;let envelope; p.sdk.http.request=async(n,o)=>{if(n!=='action')return orig(n,o);envelope=o.json;if(lost)throw Error('lost response');return response(200,{version:7,day:2});};
 const h=await api.createMiniAppHost(p.sdk);await assert.rejects(h.request('/sync/save',{method:'POST',body:{day:2,payload:{day:2},base_version:6}}));
 assert.match(envelope.request_id,/^req_[a-zA-Z0-9]{16,32}$/);const first=JSON.stringify(envelope);
 const reopened=await api.createMiniAppHost(p.sdk);assert.equal(reopened.pending().length,1);lost=false;
 const results=await reopened.retryPending();assert.equal(JSON.stringify(envelope),first);assert.equal(results[0].body.version,7);assert.equal(reopened.pending().length,0);
});
test('fixed routes flatten game args, coalesce duplicates and retain 429 same ID',async()=>{
 assert.equal(typeof api.createMiniAppHost,'function');const p=platform();const h=await api.createMiniAppHost(p.sdk);let seen=[];let status=429;
 p.sdk.http.request=async(n,o)=>{seen.push({n,o});await new Promise(r=>setTimeout(r,5));return response(status,{detail:'Too many requests. Please retry later.'},{'Retry-After':'0.01'});};
 const path='/endless/runs/run_abcdefghijklmnop/waves/wave_abcdefghijklmnop/result';const opts={method:'POST',body:{hits:[{i:0,t_ms:123}]}};
 const [a,b]=await Promise.all([h.request(path,opts),h.request(path,opts)]);assert.equal(a.response.status,429);assert.equal(seen.length,1);assert.equal(h.pending().length,1);
 assert.deepEqual(seen[0].o.json.args,{run_id:'run_abcdefghijklmnop',wave_id:'wave_abcdefghijklmnop',hits:[{i:0,t_ms:123}]});
 status=200;await new Promise(r=>setTimeout(r,15));await h.request(path,opts);assert.equal(seen[1].o.json.request_id,seen[0].o.json.request_id);assert.equal(h.pending().length,0);
 await h.request('/endless/leaderboard?board=weekly&limit=20');assert.deepEqual(seen[2].o.query,{op:'leaderboard',board:'weekly',limit:'20'});
});
test('changed account fails closed before transport; unsafe lookup IDs rejected',async()=>{
 assert.equal(typeof api.createMiniAppHost,'function');const p=platform();const h=await api.createMiniAppHost(p.sdk);const before=p.calls.length;p.account(43);
 await assert.rejects(h.request('/sync/save'),/account/i);assert.equal(p.calls.length,before);
 assert.equal(api.safeUserId('9007199254740993'),null);assert.equal(api.safeUserId('42'),42);assert.equal(api.safeUserId('1e2'),null);
});
test('transition stays blocked on durable failure and retry advances exactly once',async()=>{
 const p=platform();const h=await api.createMiniAppHost(p.sdk);p.fail(true);h.storage.setItem('save','day2');let count=0;
 h.transition(()=>count++);h.transition(()=>count++);await new Promise(r=>setTimeout(r,5));assert.equal(count,0);assert.equal(h.transitionPending,true);
 p.fail(false);await h.retryTransition();assert.equal(count,1);assert.equal(h.transitionPending,false);await h.retryTransition();assert.equal(count,1);
});
test('401 refresh preserves envelope and terminal conflict clears pending journal',async()=>{
 const p=platform();const h=await api.createMiniAppHost(p.sdk);let count=0,ids=[];
 p.sdk.http.request=async(n,o)=>{ids.push(o.json.request_id);return response(++count===1?401:409,{detail:'The endless run state has changed. Please reload.'});};
 const result=await h.request('/endless/runs/run_abcdefghijklmnop/next',{method:'POST'});assert.equal(result.response.status,409);assert.equal(ids[0],ids[1]);assert.equal(h.pending().length,0);
});
test('failed acknowledgement persistence cannot drop original pending action in memory',async()=>{
 const p=platform();const h=await api.createMiniAppHost(p.sdk);const ids=[];
 p.sdk.http.request=async(n,o)=>{ids.push(o.json.request_id);p.fail(true);return response(200,{version:8,day:2});};
 await assert.rejects(h.request('/sync/save',{method:'POST',body:{day:2,payload:{day:2},base_version:7}}));assert.equal(h.pending().length,1);
 p.fail(false);p.sdk.http.request=async(n,o)=>{ids.push(o.json.request_id);return response(200,{version:8,day:2});};
 await h.retryPending();assert.equal(ids[0],ids[1]);assert.equal(h.pending().length,0);
});
test('actual story summary and ending callbacks preserve sync contract behind durable barrier',async()=>{
 const p=platform();const h=await api.createMiniAppHost(p.sdk);const {run,sandbox}=require('../../tools/test_runtime')(7);sandbox.GameHost=h;Object.assign(sandbox.localStorage,h.storage);
 run("newGame();startDay();S.savings=100;scene='summary';now=10;sceneT0=0;initSummary();");p.fail(true);
 run('summaryClick(...center(CONTINUE_BTN));summaryClick(...center(CONTINUE_BTN));');await new Promise(r=>setTimeout(r,10));
 assert.equal(run('S.day'),2);assert.equal(run('scene'),'summary');p.fail(false);await h.retryTransition();assert.equal(run('scene'),'daycard');
 p.fail(true);const ending=run("commitEnding('E23')");assert.equal(ending,true);assert.equal(run("commitEnding('E23')"),false);await new Promise(r=>setTimeout(r,10));assert.equal(run('scene'),'daycard');
 p.fail(false);await h.retryTransition();assert.equal(run('scene'),'ending');
 const reopened=await api.createMiniAppHost(p.sdk);assert.equal(reopened.storage.getItem('ip-please-file-zero-save-v1'),null);assert.deepEqual(JSON.parse(reopened.storage.getItem('ip-please-file-zero-endings-v1')),['E23']);assert.equal(JSON.parse(reopened.storage.getItem('ip-please-file-zero-last-ending-v1')).plot.final.ending,'E23');
});
test('SDK readiness can be cancelled instead of leaving startup stuck',async()=>{
 const p=platform();p.sdk.ready=new Promise(()=>{});const controller=new AbortController();
 const pending=api.createMiniAppHost(p.sdk,{signal:controller.signal});controller.abort();
 const result=await Promise.race([pending.then(()=>false,e=>/cancel|abort/i.test(e.message)),new Promise(r=>setTimeout(()=>r(false),30))]);assert.equal(result,true);
});
test('identity change locks the old account mirror and notifies UI',async()=>{
 const p=platform();const h=await api.createMiniAppHost(p.sdk);h.storage.setItem('save','private');await h.flush();p.account(43);
 await assert.rejects(h.request('/sync/save'),/account/i);assert.equal(h.identityChanged,true);assert.equal(h.storage.getItem('save'),null);assert.throws(()=>h.storage.setItem('save','other'),/account/i);
});
