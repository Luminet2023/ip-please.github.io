const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
for(const runner of ['browser.cjs','visual.cjs'])for(const fault of ['launch','page','close'])test(runner+' cleans partial startup when '+fault+' fails',async()=>{
 const script=`
 const Module=require('node:module'),net=require('node:net');const original=Module._load,listen=net.Server.prototype.listen,servers=[];let closed=0;
 Module._load=function(name,...args){if(name.includes('playwright-core'))return {chromium:{launch:async()=>{if('${fault}'==='launch')throw Error('injected launch');return {newContext:async()=>{throw Error('injected page');},newPage:async()=>{throw Error('injected page');},close:async()=>{closed++;if('${fault}'==='close')throw Error('injected close');}};}}};return original.call(this,name,...args);};
 net.Server.prototype.listen=function(...args){servers.push(this);return listen.apply(this,args);};
 require(${JSON.stringify(path.join(__dirname,runner))});
 setTimeout(()=>{const open=servers.filter(s=>s.listening).length;console.log(JSON.stringify({open,closed}));for(const server of servers)if(server.listening){server.closeAllConnections();server.close();}},200);
 `;
 const child=spawn(process.execPath,['-e',script],{env:{...process.env,PLAYWRIGHT_CORE:'/injected/playwright-core'},stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timeout);
 assert.equal(code,1,errors);const report=JSON.parse(output.trim());assert.equal(report.open,0,'partial startup must close actual HTTP listener');assert.equal(report.closed,fault==='launch'?0:1,'allocated browser must close');
});
