// Test-only SDK boundary. This file is never included in app.zip.
(function(){
 let sequence=0;const waiting=new Map();
 window.addEventListener('message',e=>{if(e.source!==parent || !e.data?.fixtureReply)return;const entry=waiting.get(e.data.id);if(!entry)return;waiting.delete(e.data.id);e.data.error?entry.reject(Error(e.data.error)):entry.resolve(e.data.value);});
 const call=(method,args=[],opts={})=>new Promise((resolve,reject)=>{
  const id=++sequence;let timer;
  const finish=fn=>v=>{clearTimeout(timer);opts.signal?.removeEventListener('abort',abort);fn(v);};
  const abort=()=>{waiting.delete(id);finish(reject)(Error('Cancelled'));};
  waiting.set(id,{resolve:finish(resolve),reject:finish(reject)});opts.signal?.addEventListener('abort',abort,{once:true});
  if(opts.signal?.aborted)return abort();
  timer=setTimeout(()=>{waiting.delete(id);finish(reject)(Error('Timeout'));},opts.timeoutMs||20000);
  parent.postMessage({fixtureCall:true,id,method,args},'*');
 });
 window.miniApp=Object.freeze({ready:Promise.resolve(),
  user:{getCurrent:opts=>call('user',[],opts),getById:async(id,opts)=>{const user=await call('lookup',[id],opts);if(user.avatarBytes)user.avatarUrl=URL.createObjectURL(new Blob([user.avatarBytes],{type:'image/png'}));return user;}},
  localStorage:{exportData:()=>call('export'),importData:snapshot=>call('import',[snapshot]),getItem:key=>call('get',[key]),setItem:(key,value)=>call('set',[key,value])},
  http:{request:(name,options={})=>call('http',[name,{query:options.query,json:options.json}],options)},
  assets:{readBytes:(asset,opts)=>call('asset',[asset],opts)},
  theme:{get:()=>call('theme'),onChange:()=>()=>{}},lifecycle:{ready:()=>call('ready')},
  fullscreen:{request:()=>call('full',[true]),exit:()=>call('full',[false])},links:{open:url=>call('link',[url])}
 });
})();
