import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function serve(port=4173, bridge=null){const server=createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://localhost');const p=url.pathname;
 if(bridge && await bridge(req,res,url))return;
 if(p==='/frame'){
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; font-src 'none'; connect-src 'none'; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'");
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/web/app.css"></head><body>'+await readFile(path.join(here,'../dist/web/index.html'),'utf8')+'<script src="/frame.js"></script><script src="/web/app.js"></script></body></html>');return;
 }
 const mapped=p==='/'?'index.html':p.slice(1);if(mapped.includes('..')||!/^[-a-zA-Z0-9_./]+$/.test(mapped))throw Error('path');
 const file=mapped.startsWith('web/')?path.join(here,'../dist',mapped):path.join(here,mapped);
 res.setHeader('Content-Type',mapped.endsWith('.js')?'text/javascript':mapped.endsWith('.css')?'text/css':mapped.endsWith('.png')?'image/png':'text/html; charset=utf-8');res.end(await readFile(file));
 }catch(_){res.statusCode=404;res.end('Not found');}
 });await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return server;}
if(process.argv[1]===fileURLToPath(import.meta.url)){const s=await serve(Number(process.env.PORT||4173));console.log('Strict sandbox preview: http://127.0.0.1:'+s.address().port);}
