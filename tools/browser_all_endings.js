#!/usr/bin/env node
'use strict';
// Runs the normal browser input driver, once per ending, from a fresh new game.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {IDS}=require('./ending_routes');
const OUT=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||path.join(__dirname,'test-results'));
fs.mkdirSync(OUT,{recursive:true});
const option=(name,fallback)=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
const headless=process.argv.includes('--headless');
const jobs=headless?Math.max(1,Math.min(4,Number(option('jobs','4')))):1;
if(!Number.isInteger(jobs))throw Error('--jobs must be an integer from 1 to 4');
const speed=option('speed',headless?'12':'1');
const pause=option('pause',headless?'0':'150');
let selected=option('ending','all')==='all'?[...IDS]:option('ending','').split(',');
selected=[...new Set(selected)];
if(selected.some(id=>!IDS.includes(id))) throw Error('Use --ending=E01 or --ending=E01,E02, or omit for all 30');
// E30 requires a legitimately unlocked earlier ending. Re-run E27 if selected alone.
if(selected.includes('E30') && selected.length===1) selected.unshift('E27');
const archiveFile=path.join(OUT,'automation-archive.json');
const archive=new Set();
fs.writeFileSync(archiveFile,'[]');
const results=[];
const children=new Set();
const started=new Date().toISOString();
let index=0;
async function run(id) {
  const args=[path.join(__dirname,'browser_playthrough.js'),'--ending='+id,'--prefix='+id,'--compact','--speed='+speed,'--pause='+pause,'--archive='+archiveFile,'--out='+OUT];
  if(!headless)args.push('--headed');
  console.log('\n▶ '+id+' · 从第 1 天开始');
  const code=await new Promise(resolve=>{
    const child=spawn(process.execPath,args,{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe'],windowsHide:headless});
    children.add(child);
    for(const stream of [child.stdout,child.stderr])stream.on('data',d=>process.stdout.write('['+id+'] '+d));
    child.on('error',e=>{console.error(e);resolve(1);});
    child.on('exit',c=>{children.delete(child);resolve(c);});
  });
  let report;
  try{report=JSON.parse(fs.readFileSync(path.join(OUT,id+'-playthrough.json'),'utf8'));}catch{}
  const ok=code===0 && report?.ending===id;
  results.push({id,ok,day:report?.final?.day,cases:report?.cases.length,errors:report?.errors,failure:report?.failure});
  if(ok){archive.add(id);fs.writeFileSync(archiveFile,JSON.stringify([...archive]));}
  fs.writeFileSync(path.join(OUT,'all-endings.json'),JSON.stringify({started,mode:'from day 1, real browser input',headless,results},null,2));
  console.log((ok?'✓ ':'✗ ')+id+' '+(ok?'完成':'失败；截图和状态已保存在 tools/test-results'));
}
async function worker(){while(index<selected.length){const id=selected[index++];if(id==='E30')continue;await run(id);}}
process.on('SIGINT',()=>{for(const child of children)child.kill();process.exit(130);});
(async()=>{
  await Promise.all(Array.from({length:jobs},worker));
  if(selected.includes('E30')) {
    if(archive.size) await run('E30');
    else throw Error('E30 needs a successfully completed previous ending');
  }
  const passed=results.filter(r=>r.ok).length;
  console.log('\n'+passed+'/'+results.length+' 个结局通过。报告：'+path.join(OUT,'all-endings.json'));
  require('./render_ending_report')(path.join(OUT,'all-endings.json'));
  if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
