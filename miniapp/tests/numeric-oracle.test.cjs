const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const crypto=require('node:crypto');const path=require('node:path');
test('pinned official SDK accepts signed integer-value JSON numbers and rejects invalid numeric claims',async()=>{
 const {verifyPlatformRequest}=await import('../vendor/sdk/server.mjs');
 const key=crypto.createPrivateKey(fs.readFileSync(path.join(__dirname,'../../backend/tests/fixtures/test_mapp_private.pem'))),publicKey=crypto.createPublicKey(key);
 const now=1794140000, url='https://api.luminet.cn/anthropic/v1/mapp/query';
 const header={alg:'ES256',typ:'mini-app-access+jwt',kid:crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')};
 const base={iss:'https://linux.do',aud:'https://api.luminet.cn',app_id:'test-miniapp',channel:'sandbox',sub:'123',version:'1.0.0',scopes:['network.request'],iat:now,nbf:now,exp:now+300,jti:'fixture_request_0123456789',htm:'GET',htu:url,query_keys:['op'],trust_level:1};
 const check=async(field,raw,expected)=>{
  const payload=JSON.stringify(base).replace(new RegExp('"'+field+'":(?:-?[0-9.]+)'), '"'+field+'":'+raw);
  const data=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(payload).toString('base64url');
  const authorization='Bearer '+data+'.'+crypto.sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const args={authorization,publicKey,issuer:base.iss,audience:base.aud,appId:base.app_id,scope:'network.request',method:'GET',url:url+'?op=daily',channel:'sandbox',now};
  if(expected)await verifyPlatformRequest(args);else await assert.rejects(()=>verifyPlatformRequest(args));
 };
 for(const [field,value] of [['iat',now],['nbf',now],['exp',now+300],['trust_level',0],['trust_level',1],['trust_level',4]])await check(field,value+'.0',true);
 for(const field of ['iat','nbf','exp','trust_level'])for(const bad of ['null','"1"','true','1.5','9007199254740992'])await check(field,bad,false);
 for(const bad of ['-1.0','5.0','256.0'])await check('trust_level',bad,false);
});
