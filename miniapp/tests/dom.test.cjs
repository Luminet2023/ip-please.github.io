const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {JSDOM}=require('../../tests/frontend/node_modules/jsdom');
test('cloud login, credits, dialogs and admin announcements render under forbidden HTML sinks',async(t)=>{
 const dom=new JSDOM('<button id="cloud"></button><div id="toast"></div><div id="cloud-panel" hidden></div><div id="cloud-overlay" hidden></div><div id="announce"></div>',{url:'https://game.test',runScripts:'outside-only'});
 const w=dom.window; const descriptor=Object.getOwnPropertyDescriptor(w.Element.prototype,'innerHTML');t.after(()=>{Object.defineProperty(w.Element.prototype,'innerHTML',descriptor);w.close();});w.fetch=async()=>({ok:true,status:200,text:async()=>'{"announcements":[]}',headers:{get:()=>null}});
 Object.defineProperty(w.Element.prototype,'innerHTML',{set(){throw Error('Forbidden HTML sink');}});
 for(const f of ['config.js','cloud.js','announce.js'])vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../..',f),'utf8'),dom.getInternalVMContext());
 await new Promise(r=>setTimeout(r,20));
 w.CloudSync.openPanel();assert.match(w.document.querySelector('#cloud-panel').textContent,/File Zero/);assert.equal(w.document.querySelectorAll('.credit a').length,2);
 w.CloudSync.ui.showDialog({title:'<img src=x>',paragraphs:['<script>alert(1)</script>'],buttons:[{label:'OK',onClick(){}}]});
 assert.equal(w.document.querySelector('.dialog h2').textContent,'<img src=x>');assert.equal(w.document.querySelectorAll('.dialog img,.dialog script').length,0);
 w.CloudSync.ui.closeDialog();assert.equal(w.document.querySelector('#cloud-overlay').childNodes.length,0);
});
test('an opening touch compatibility click cannot immediately dismiss the new overlay',async(t)=>{
 const dom=new JSDOM('<div id="cloud-overlay" hidden></div>',{url:'https://game.test',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.fetch=async()=>({ok:true,status:200,text:async()=>'{"announcements":[]}',headers:{get:()=>null}});
 for(const f of ['config.js','cloud.js'])vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname,'../..',f),'utf8'),dom.getInternalVMContext());
 w.CloudSync.ui.showDialog({title:'Confirm',paragraphs:[],buttons:[]});const overlay=w.document.getElementById('cloud-overlay');
 overlay.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(overlay.hidden,false);
 overlay.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));overlay.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(overlay.hidden,true);
});
