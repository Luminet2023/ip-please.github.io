const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');const {createHash}=require('node:crypto');const {JSDOM}=require('../../tests/frontend/node_modules/jsdom');
const root=path.resolve(__dirname,'../..');
test('official package has only declared game bytes, restrictive permissions and exact fixed endpoint contracts',()=>{
 const archive=path.join(root,'miniapp/dist/package/app.zip');const info=JSON.parse(execFileSync('python3',['-c',"import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names':z.namelist(),'manifest':json.loads(z.read('manifest.json')),'size':sum(x.file_size for x in z.infolist())}))",archive],{encoding:'utf8'}));
 const m=info.manifest;
 assert.deepEqual(info.names.sort(),['app.css','app.js','index.html','manifest.json','strings.json',...m.assets].sort());
 assert.equal(m.id,'01a1baa6-abbf-7ed6-afac-bfa495a47dd3');assert.deepEqual(m.permissions.slice().sort(),['user.read','user.lookup','network.request','storage.read','storage.write','theme.read','audio.webAudio','fullscreen','links.open'].sort());
 for(const [name,method] of [['bootstrap','GET'],['profile','POST'],['query','GET'],['action','POST']])assert.deepEqual([m.endpoints[name].url,m.endpoints[name].method,m.endpoints[name].auth],['https://api.luminet.cn/anthropic/v1/mapp/'+name,method,'platform']);
 assert.deepEqual(m.endpoints.query.query,['op','save_id','run_id','board','period','limit']);
 assert.ok(fs.statSync(archive).size<=32*1024*1024);assert.ok(info.size<=128*1024*1024);
 const hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');assert.equal(fs.readFileSync(path.join(root,'miniapp/dist/package/SHA256SUMS'),'utf8'),hash+'  app.zip\n');
 const fragment=fs.readFileSync(path.join(root,'miniapp/dist/web/index.html'),'utf8');const d=new JSDOM(fragment).window.document;
 assert.equal(d.querySelectorAll('script,style,iframe,object,embed').length,0);
 for(const el of d.querySelectorAll('*'))for(const a of el.attributes)assert.ok(!/^on|^style$/i.test(a.name),a.name);
 const assets=fs.readFileSync(path.join(root,'assets.js'),'utf8');for(const match of assets.matchAll(/(font|atlas|bg|win): "data:image\/png;base64,([A-Za-z0-9+/=]+)"/g))assert.deepEqual(fs.readFileSync(path.join(root,'miniapp/dist/web/assets',match[1]+'.png')),Buffer.from(match[2],'base64'));
});
