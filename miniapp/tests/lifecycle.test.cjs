const {test}=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const artifactDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'ip-please-lifecycle-'));
const previousArtifacts=process.env.BROWSER_ARTIFACTS;process.env.BROWSER_ARTIFACTS=artifactDirectory;
const {run}=require('./backend-browser.cjs');
if(previousArtifacts===undefined)delete process.env.BROWSER_ARTIFACTS;else process.env.BROWSER_ARTIFACTS=previousArtifacts;
require('node:test').after(()=>fs.rmSync(artifactDirectory,{recursive:true,force:true}));
async function resources(t,script){
 const {startBackend}=await import('./backend-bridge.mjs');const {serve}=await import('../preview/server.mjs');
 let server,child;
 // Fault-test cleanup prevents a broken harness from hanging this test process.
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
 return {start:()=>startBackend({startupTimeoutMs:150,serveFixture:async(...args)=>(server=await serve(...args)),spawnProcess:()=>child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']})}),assertClosed:()=>{assert.equal(server.listening,false,'fixture HTTP listener must close');if(child.pid)assert.ok(child.exitCode!==null||child.signalCode!==null,'fixture process must be reaped before rejection');}};
}
test('backend startup exit closes its existing HTTP listener',async t=>{
 const r=await resources(t,'process.exit(7)');await assert.rejects(r.start,/Backend exited 7/);r.assertClosed();
});
test('backend startup deadline closes listener and kills a nonresponsive child',async t=>{
 const r=await resources(t,'setInterval(()=>{},1000)');await assert.rejects(r.start,/startup timeout/);r.assertClosed();
});
test('browser launch failure closes a successfully initialized fixture',async t=>{
 const r=await resources(t,"console.log('FIXTURE_BACKEND=http://127.0.0.1:1');setInterval(()=>{},1000)");
 await assert.rejects(()=>run({startBackend:r.start,launchBrowser:async()=>{throw Error('browser launch fault');}}),/browser launch fault/);r.assertClosed();
});
