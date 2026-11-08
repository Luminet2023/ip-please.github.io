// Only a local SDK boundary: all business responses come from the real Rust HTTP app.
import {readFile} from 'node:fs/promises';
import {createPrivateKey,sign,randomInt} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {serve} from '../preview/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function startBackend({spawnProcess=spawn,serveFixture=serve,startupTimeoutMs=180000}={}){
 const jwks=JSON.parse(await readFile(path.join(root,'backend/tests/fixtures/test_mapp_jwks.json'),'utf8'));
 const key=createPrivateKey(await readFile(path.join(root,'backend/tests/fixtures/test_mapp_private.pem')));
 const subject=String(randomInt(100000000,999999999));
 let backend;const calls=[];
 const server=await serveFixture(0,async(req,res,url)=>{
  if(url.pathname==='/jwks'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(jwks));return true;}
  if(url.pathname!=='/bridge')return false;
  let input='';for await(const chunk of req)input+=chunk;
  const {name,options={},account=42,channel='sandbox'}=JSON.parse(input);
  if(!['bootstrap','profile','query','action'].includes(name))throw Error('fixed endpoints only');
  const method=['bootstrap','query'].includes(name)?'GET':'POST',base='/anthropic/v1/mapp/'+name;
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'https://linux.do',aud:'https://api.luminet.cn',app_id:'01a1baa6-abbf-7ed6-afac-bfa495a47dd3',channel,sub:String(account),version:'1.0.0',scopes:['network.request'],iat:now,nbf:now,exp:now+300,jti:'fixture_request_0123456789',htm:method,htu:'https://api.luminet.cn'+base,query_keys:['op','save_id','run_id','board','period','limit'],trust_level:1};
  const body=options.json?structuredClone(options.json):undefined;
  const data=Buffer.from(JSON.stringify({alg:'ES256',typ:'mini-app-access+jwt',kid:jwks.keys[0].kid})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token=data+'.'+sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const query=new URLSearchParams(options.query||{}).toString();
  const response=await fetch(backend+base+(query?'?'+query:''),{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value={status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()};
  calls.push({name,request:body||options.query,response:value});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return true;
 });
 const url='http://127.0.0.1:'+server.address().port;
 let child,closing;
 const close=()=>closing ||= (async()=>{
  try {
   if(child?.pid && child.exitCode===null && child.signalCode===null) {
    await new Promise(resolve=>{
     const force=setTimeout(()=>child.kill('SIGKILL'),1000);
     child.once('exit',()=>{clearTimeout(force);resolve();});
     child.kill('SIGTERM');
    });
   }
  } finally {
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
  }
 })();
 try {
  child=spawnProcess('cargo',['run','--locked','--manifest-path','backend/Cargo.toml','--example','miniapp_fixture'],{cwd:root,env:{...process.env,FIXTURE_JWKS_URL:url+'/jwks'},stdio:['ignore','pipe','pipe']});
  let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b;});
  backend=await new Promise((resolve,reject)=>{
   let data='';
   const finish=(error,value)=>{
    clearTimeout(timer);child.stdout.off('data',onData);child.off('exit',onExit);child.off('error',onError);
    if(error)reject(error);else resolve(value);
   };
   const onData=b=>{data+=b;const match=data.match(/FIXTURE_BACKEND=(http:\/\/[^\s]+)/);if(match)finish(null,match[1]);};
   const onExit=code=>finish(Error('Backend exited '+code+': '+diagnostic));
   const onError=error=>finish(error);
   const timer=setTimeout(()=>finish(Error('Backend startup timeout: '+diagnostic)),startupTimeoutMs);
   child.stdout.on('data',onData);child.once('exit',onExit);child.once('error',onError);
  });
  return {url:url+'/?backend=1&subject='+subject,calls,subject,backend,audit:async()=> (await fetch(backend+'/anthropic/v1/fixture/audit?subject='+subject)).json(),close};
 } catch(error) {
  await close();throw error;
 }
}
