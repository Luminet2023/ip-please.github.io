import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pack} from './vendor/sdk/pack.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)), root=path.dirname(here);
const read=p=>readFile(path.join(root,p),'utf8');
const manifest=JSON.parse(await read('miniapp/manifest.json'));
const provenance=JSON.parse(await read('miniapp/vendor/provenance.json'));
for(const [file,hash] of Object.entries(provenance.files)) {
 const bytes=await readFile(path.join(here,'vendor/sdk',file));
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('SDK provenance mismatch: '+file);
}
const html=await read('index.html');
const scripts=[...html.matchAll(/<script src="([^"?]+)(?:\?[^\"]*)?"><\/script>/g)].map(m=>m[1]).filter(f=>f!=='game-host.js');
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1]+'\n#host-shell{position:fixed;inset:0;z-index:30;background:#161313;color:#e4dfd4;display:grid;place-content:center;text-align:center;font:16px system-ui;padding:24px}#host-shell[hidden],#host-storage[hidden]{display:none}#host-shell button,#host-storage button{padding:8px;margin:8px}#host-storage{position:fixed;bottom:8px;left:8px;right:8px;z-index:25;background:#34201b;color:#ffe3ba;padding:10px;font:13px system-ui}.snapshots{display:flex;flex-direction:column;max-height:45vh;overflow:auto}#rotate-dismiss{margin-top:8px;padding:6px 14px}\n';
let fragment=html.split('<body>')[1].split('<script')[0].replace(/ onclick="[^"]*"/g,'').replace(/ style="[^"]*"/g,'').replace('<button type="button">先竖着玩','<button id="rotate-dismiss" type="button">先竖着玩');
fragment+='<div id="host-shell" role="status"><p id="host-status">Loading / 载入中…</p><div><button id="host-retry" hidden>Retry / 重试</button><button id="host-cancel">Cancel / 取消</button></div></div><div id="host-storage" role="status" hidden><span id="host-storage-text"></span><button id="host-storage-retry">Retry / 重试</button></div>';
const files={'index.html':fragment,'app.css':css,'strings.json':await read('miniapp/strings.json')};
files['assets/LICENSE.txt']=await read('LICENSE');files['assets/OFL-fusion-pixel.txt']=await read('OFL-fusion-pixel.txt');
const sources=[];
for(const f of scripts) {
 let source=await read(f);
 if(f==='assets.js') source=source.replace(/(font|atlas|bg|win): "data:image\/png;base64,([A-Za-z0-9+/=]+)"/g,(_,key,base64)=>{files['assets/'+key+'.png']=Buffer.from(base64,'base64');return key+': images.'+key;});
 sources.push('// '+f+'\n'+source);
}
const sdk=(await read('miniapp/vendor/sdk/index.mjs')).replace(/export\{i as getSDK\};?/, 'const getSDK=i;');
files['app.js']='(function(){\n"use strict";\n'+sdk+'\n'+await read('game-host.js')+'\n'+await read('miniapp/entry-prefix.js')+'\n'+sources.join('\n;\n')+'\n'+await read('miniapp/entry-suffix.js')+'\n})();\n';
for(const bad of [/\.innerHTML\s*=/,/insertAdjacentHTML\s*\(/,/\beval\s*\(/,/new\s+Function\s*\(/]) if(bad.test(files['app.js']))throw Error('Forbidden executable sink: '+bad);
if(/\son\w+=|<script|<style|\sstyle=/.test(fragment))throw Error('Unsafe markup');
const dist=path.join(here,'dist');await rm(dist,{recursive:true,force:true});await mkdir(path.join(dist,'web/assets'),{recursive:true});
for(const [file,contents] of Object.entries(files))await writeFile(path.join(dist,'web',file),contents);
const result=await pack({manifest,files,outputDirectory:path.join(dist,'package')});
await writeFile(path.join(dist,'package/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(dist,'package/SHA256SUMS'),result.zipSha256+'  app.zip\n');
console.log(JSON.stringify(result));
