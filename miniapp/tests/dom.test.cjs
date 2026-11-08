const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {JSDOM,VirtualConsole}=require('../../tests/frontend/node_modules/jsdom');
function checkedDOM(t,html) {
 const errors=[];const virtualConsole=new VirtualConsole();
 virtualConsole.on('jsdomError',error=>errors.push(error));
 const dom=new JSDOM(html,{url:'https://game.test',runScripts:'outside-only',virtualConsole});
 t.after(async()=>{await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(errors.map(e=>e.message),[], 'asynchronous jsdom initialization must be error-free');});
 return dom;
}
test('cloud login, credits, dialogs and admin announcements render under forbidden HTML sinks',async(t)=>{
 const dom=checkedDOM(t,'<button id="cloud"></button><div id="toast"></div><div id="cloud-panel" hidden></div><div id="cloud-overlay" hidden></div><div id="announce"></div>');
 const w=dom.window; const descriptor=Object.getOwnPropertyDescriptor(w.Element.prototype,'innerHTML');t.after(()=>{Object.defineProperty(w.Element.prototype,'innerHTML',descriptor);w.close();});w.fetch=async()=>({ok:true,status:200,text:async()=>'{"announcements":[]}',headers:{get:()=>null}});
 Object.defineProperty(w.Element.prototype,'innerHTML',{set(){throw Error('Forbidden HTML sink');}});
 for(const f of ['config.js','cloud.js','announce.js'])vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../..',f),'utf8'),dom.getInternalVMContext());
 await new Promise(r=>setTimeout(r,20));
 w.CloudSync.openPanel();assert.match(w.document.querySelector('#cloud-panel').textContent,/File Zero/);assert.equal(w.document.querySelectorAll('.credit a').length,3);
 assert.match(w.document.querySelector('.credit').textContent,/本项目完全开源/);
 assert.equal(w.document.querySelector('.credit a:last-child').href,'https://github.com/Luminet2023/ip-please.github.io');
 w.CloudSync.ui.showDialog({title:'<img src=x>',paragraphs:['<script>alert(1)</script>'],buttons:[{label:'OK',onClick(){}}]});
 assert.equal(w.document.querySelector('.dialog h2').textContent,'<img src=x>');assert.equal(w.document.querySelectorAll('.dialog img,.dialog script').length,0);
 w.CloudSync.ui.closeDialog();assert.equal(w.document.querySelector('#cloud-overlay').childNodes.length,0);
});
test('an opening touch compatibility click cannot immediately dismiss the new overlay',async(t)=>{
 const dom=checkedDOM(t,'<div id="cloud-overlay" hidden></div>');t.after(()=>dom.window.close());const w=dom.window;w.fetch=async()=>({ok:true,status:200,text:async()=>'{"announcements":[]}',headers:{get:()=>null}});
 for(const f of ['config.js','cloud.js'])vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../..',f),'utf8'),dom.getInternalVMContext());
 w.CloudSync.ui.showDialog({title:'Confirm',paragraphs:[],buttons:[]});const overlay=w.document.getElementById('cloud-overlay');
 overlay.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(overlay.hidden,false);
 overlay.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));overlay.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(overlay.hidden,true);
});
test('offscreen avatar observers release removed boards, retain visible lazy loading and fallback',async(t)=>{
 const dom=checkedDOM(t,'<div id="cloud-overlay" hidden></div>');t.after(()=>dom.window.close());const w=dom.window;
 const watched=new Map();let lookups=0;
 w.IntersectionObserver=class {constructor(cb){this.cb=cb;this.nodes=new Set();}observe(n){this.nodes.add(n);watched.set(n,this);}unobserve(n){this.nodes.delete(n);watched.delete(n);}disconnect(){for(const n of this.nodes)watched.delete(n);this.nodes.clear();}};
 w.GameHost={isMiniApp:true,avatar:async()=>{lookups++;return 'blob:fixture';},bootstrap:{user:{user_id:'user_fixture000000001'},channel:'sandbox'},subscribe:()=>()=>{},pending:()=>[]};
 w.fetch=async()=>({ok:true,status:200,text:async()=>'{"announcements":[]}',headers:{get:()=>null}});
 for(const f of ['config.js','cloud.js'])vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../..',f),'utf8'),dom.getInternalVMContext());
 const turn=()=>new Promise(r=>setTimeout(r,0));const show=()=>{w.CloudSync.ui.showDialog({title:'Board',paragraphs:[],buttons:[]});const slot=w.CloudSync.ui.avatar({linuxdo_id:'42',display_name:'Fallback'});w.document.querySelector('.dialog').append(slot);return slot;};
 show();await turn();assert.equal(watched.size,1);assert.equal(lookups,0);
 w.CloudSync.ui.closeDialog();await turn();assert.equal(watched.size,0,'closing an unseen board must release its observer');
 show();const slot=show();await turn();assert.equal(watched.size,1,'replacing an unseen board releases detached rows');
 watched.get(slot).cb([{target:slot,isIntersecting:true}]);await turn();assert.equal(watched.size,0);assert.equal(lookups,1);assert.ok(slot.querySelector('img'));
 slot.querySelector('img').dispatchEvent(new w.Event('error'));assert.equal(slot.textContent,'F');
 // A late response must not create observers in a board that was already closed.
 w.T=x=>x;vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../../endless.js'),'utf8'),dom.getInternalVMContext());
 let resolveBoard;w.CloudSync.optionalAuthApi=()=>new Promise(resolve=>{resolveBoard=resolve;});
 const loading=w.Endless.openLeaderboard('endless');w.CloudSync.ui.closeDialog();
 resolveBoard({entries:[{rank:1,linuxdo_id:'43',display_name:'Late',score:1}],me:null});await loading;await turn();assert.equal(watched.size,0,'late closed-board response must not retain detached avatar');

});
