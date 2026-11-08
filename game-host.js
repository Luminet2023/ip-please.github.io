'use strict';
// Capability boundary shared by the no-build website and the packaged game.
(function (root) {
  function safeUserId(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function route(path, settings = {}) {
    const url = new URL(path, 'https://api.luminet.cn');
    if (!path.startsWith('/') || url.origin !== 'https://api.luminet.cn') throw Error('Unsupported platform route');
    const post = settings.method === 'POST';
    const body = settings.body || {};
    const query = Object.fromEntries(url.searchParams);
    const p = url.pathname;
    if (p === '/sync/save') return post ? {op:'save',args:body} : {query:{op:'save'}};
    if (!post && p === '/sync/snapshots') return {query:{op:'snapshots',...query}};
    const snapshot = p.match(/^\/sync\/snapshots\/(save_[a-zA-Z0-9]{16,32})$/);
    if (!post && snapshot) return {query:{op:'snapshot',save_id:snapshot[1]}};
    if (!post && p === '/announcements') return {query:{op:'announcements'}};
    if (!post && p === '/endless/daily') return {query:{op:'daily'}};
    if (!post && p === '/endless/leaderboard') return {query:{op:'leaderboard',...query}};
    if (post && p === '/endless/runs') return {op:'run_start',args:body};
    if (!post && p === '/endless/runs/current') return {query:{op:'run_current'}};
    const run = p.match(/^\/endless\/runs\/(run_[a-zA-Z0-9]{16,32})(?:\/(next|inspect|quiz|decision|abandon)|\/waves\/(wave_[a-zA-Z0-9]{16,32})\/result)?$/);
    if (run) {
      if (!post && !run[2] && !run[3]) return {query:{op:'run',run_id:run[1]}};
      if (post && run[3]) return {op:'wave_result',args:{...body,run_id:run[1],wave_id:run[3]}};
      if (post && run[2]) return {op:'run_' + run[2],args:{...body,run_id:run[1]}};
    }
    throw Error('Unsupported platform route');
  }
  function wrap(result) {
    return {body:result.body,response:{status:result.status,ok:result.status>=200 && result.status<300,
      headers:{get:name=>Object.entries(result.headers||{}).find(([k])=>k.toLowerCase()===name.toLowerCase())?.[1] || null}}};
  }
  async function createMiniAppHost(sdk, options = {}) {
    const listeners = new Set();
    const notify = () => listeners.forEach(fn=>fn());
    let identityChanged = false;
    function cancellable(promise) {
      return new Promise((resolve,reject)=>{
        const done = fn => value => { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); fn(value); };
        const abort = () => done(reject)(Error('Cancelled'));
        const timer = setTimeout(()=>done(reject)(Error('Connection timed out. Retry.')),20000);
        options.signal?.addEventListener('abort',abort,{once:true});
        if(options.signal?.aborted)abort();
        promise.then(done(resolve),done(reject));
      });
    }
    await cancellable(sdk.ready);
    const profile = await sdk.user.getCurrent({signal:options.signal,timeoutMs:20000});
    if (!profile || !Number.isSafeInteger(profile.id) || profile.id <= 0) throw Error('Please sign in to LINUX DO.');
    async function checkIdentity() {
      const current = await sdk.user.getCurrent({signal:options.signal,timeoutMs:20000});
      if (!current || current.id !== profile.id) { identityChanged=true; notify(); throw Error('Platform account changed. Reopen this app.'); }
    }
    async function raw(name, opts = {}) {
      await checkIdentity();
      const requestOptions = {...opts,signal:options.signal,timeoutMs:20000};
      try {
        let result = await sdk.http.request(name, requestOptions);
        // The SDK invalidates authorization after 401; the next call obtains fresh authorization.
        if (result.status === 401) { await checkIdentity(); result = await sdk.http.request(name, requestOptions); }
        return result;
      } catch (error) { if(!identityChanged) error.network=true; throw error; }
    }
    const boot = await raw('bootstrap');
    if (boot.status !== 200 || !boot.body?.user || boot.body.user.linuxdo_id !== String(profile.id)) throw Error('Platform bootstrap failed. Retry to reconnect.');
    const bootstrap = boot.body;
    const synced = await raw('profile',{json:{id:String(profile.id),username:profile.username,name:profile.name || null}});
    if (synced.status !== 200 || synced.body?.user_id !== bootstrap.user.user_id) throw Error('Platform profile sync failed.');
    const user = synced.body;
    // The SDK isolates channels. Explicit channel/user prefixes also make exports unambiguous.
    // Legacy account blobs are a read-only migration base, never a write target.
    const scope = 'ip-please:account:' + user.user_id;
    const prefix = scope + ':v2:' + bootstrap.channel + ':';
    const endingsKey = 'ip-please-file-zero-endings-v1';
    const pendingKey = 'pending-actions-v1';
    const metaKey = 'ip-please-sync-meta-v1:' + user.user_id;
    const forbidden = key => /(?:auth|login|token|credential|cookie)/i.test(key);
    let memory = Object.create(null), records = new Map(), pending = [];
    const dirty = new Map();
    let writes = Promise.resolve(), scheduled = false, persistenceError = null;
    function put(key, value) { dirty.set(prefix + key, JSON.stringify(value)); }
    function rebuild(snapshot) {
      const all = new Map(snapshot.entries);
      const legacy = JSON.parse(all.get(scope) || '{}');
      memory = Object.assign(Object.create(null), legacy);
      records = new Map([...all].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>[key.slice(prefix.length),JSON.parse(value)]));
      for (const [key,value] of dirty) records.set(key.slice(prefix.length),JSON.parse(value));
      const endings = new Set(JSON.parse(legacy[endingsKey] || '[]'));
      const actions = new Map(JSON.parse(legacy[pendingKey] || '[]').map(p=>[p.request_id,p]));
      for (const [key,value] of records) {
        if (key.startsWith('key:')) {
          const name=decodeURIComponent(key.slice(4));
          if(value===null)delete memory[name];else memory[name]=value;
        } else if (key.startsWith('ending:')) endings.add(value);
        else if (key.startsWith('request:')) actions.set(value.request_id,value);
      }
      let meta=JSON.parse(memory[metaKey] || 'null');
      for (const [key,value] of records) if(key.startsWith('ack:')) {
        actions.delete(key.slice(4));
        if(value.meta && (!meta || value.meta.version>meta.version))meta=value.meta;
      }
      if(meta)memory[metaKey]=JSON.stringify(meta);
      if(endings.size)memory[endingsKey]=JSON.stringify([...endings].sort());
      pending=[...actions.values()].map(p=>({...p,...records.get('retry:'+p.request_id)}));
      memory[pendingKey]=JSON.stringify(pending);
      for (const key of Object.keys(memory)) if(forbidden(key))delete memory[key];
    }
    async function refresh() { rebuild(await cancellable(sdk.localStorage.exportData())); }
    await refresh();
    function flush() {
      const work = writes.catch(()=>{}).then(async()=>{
        if (identityChanged) throw Error('Platform account changed. Reopen this app.');
        try {
          while(dirty.size) {
            const batch=new Map(dirty);
            // Atomic merge only of dirty keys. No cross-window read/modify/write lock is needed.
            await sdk.localStorage.importData({format:1,entries:[...batch]});
            for(const [key,value] of batch)if(dirty.get(key)===value)dirty.delete(key);
          }
          await refresh();persistenceError=null;
        } catch(error) {persistenceError=error;notify();throw error;}
        notify();
      });
      writes=work;return work;
    }
    function changed() {
      if (scheduled) return;
      scheduled=true;
      Promise.resolve().then(()=>{scheduled=false;flush().catch(()=>{});});
    }
    const storage = {
      getItem(key) { return !identityChanged && Object.hasOwn(memory,key) ? memory[key] : null; },
      setItem(key,value) {
        if(identityChanged)throw Error('Platform account changed. Reopen this app.');
        key=String(key);if(forbidden(key))throw Error('Credentials are forbidden in platform storage');
        value=String(value);
        if(key===endingsKey) {
          const endings=new Set([...JSON.parse(memory[key]||'[]'),...JSON.parse(value)]);
          for(const id of endings)put('ending:'+encodeURIComponent(id),id);
          memory[key]=JSON.stringify([...endings].sort());
        } else {memory[key]=value;put('key:'+encodeURIComponent(key),value);}
        changed();
      },
      removeItem(key) {
        if(identityChanged)throw Error('Platform account changed. Reopen this app.');
        key=String(key);delete memory[key];put('key:'+encodeURIComponent(key),null);changed();
      },
    };
    const inflight = new Map();
    const operation = record => ({request_id:record.request_id,op:record.op,args:record.args});
    async function acknowledge(record, result) {
      const ack={request_id:record.request_id};
      if(record.op==='save' && result?.status>=200 && result.status<300) {
        const b=result.body;ack.meta={version:b.version,day:b.day,save_id:b.save_id,synced_at:b.updated_at};
      }
      // Ack and metadata are one immutable value. Older completions cannot roll back the maximum version.
      put('ack:'+record.request_id,ack);await flush();
    }
    async function execute(record) {
      if (inflight.has(record.request_id)) return inflight.get(record.request_id);
      const work = (async()=>{
        // Also migrate a legacy pending envelope unchanged before sending it.
        put('request:'+record.request_id,operation(record));
        await flush();
        const conflict=records.get('conflict:'+record.request_id);
        if(conflict)return {...wrap(conflict),operation:operation(record)};
        if (record.retryAt && record.retryAt>Date.now()) {
          return {...wrap({status:429,headers:{'Retry-After':String(Math.ceil((record.retryAt-Date.now())/1000))},body:{detail:'Too many requests. Please retry later.'}}),operation:operation(record)};
        }
        const result = await raw('action',{json:operation(record)});
        if (result.status === 429 || result.status >= 500 || result.status === 401 || result.status === 408) {
          const retry = Number(Object.entries(result.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]);
          record.retryAt = Date.now() + (retry>0?retry*1000:0);
          put('retry:'+record.request_id,{retryAt:record.retryAt});await flush();
        } else if(record.op==='save' && result.status===409 && result.body?.detail==='The cloud save has a newer version than the client base version.') {
          // Only the player's cloud/local choice acknowledges a save conflict.
          put('conflict:'+record.request_id,result);await flush();
        } else await acknowledge(record,result);
        return {...wrap(result),operation:operation(record)};
      })();
      inflight.set(record.request_id,work);
      try { return await work; } finally {inflight.delete(record.request_id);notify();}
    }
    async function request(path, settings) {
      const mapped = route(path,settings);
      if (mapped.query) return wrap(await raw('query',{query:mapped.query}));
      const fingerprint = canonical(mapped);
      const replaces=settings?.replacesRequestId;
      let record = pending.find(p=>p.request_id!==replaces && canonical({op:p.op,args:p.args})===fingerprint);
      if (!record) {
        if (pending.some(p=>p.request_id!==replaces)) { const error=Error('An earlier action is awaiting acknowledgement. Retry it first.');error.pending=true;throw error; }
        const bytes=new Uint8Array(16);root.crypto.getRandomValues(bytes);
        record={request_id:'req_'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''),...JSON.parse(JSON.stringify(mapped))};
        pending.push(record);put('request:'+record.request_id,operation(record));
        if(replaces)put('ack:'+replaces,{request_id:replaces});
      }
      return execute(record);
    }
    let transition = null;
    let transitionBusy = false;
    async function retryTransition() {
      if (transitionBusy || !transition) return;
      transitionBusy=true;notify();
      try {await flush();const next=transition;transition=null;next();}
      catch (_) { /* Dirty mirror and callback remain available to the visible retry control. */ }
      finally {transitionBusy=false;notify();}
    }
    const avatars = new Map();
    let fullscreen=false;
    const host = {
      isMiniApp:true,sdk,user,bootstrap,storage,flush,profile,locale:(await sdk.theme.get()).locale,
      request,checkIdentity,get identityChanged(){return identityChanged;},pending:()=>pending.map(p=>JSON.parse(JSON.stringify(p))),
      async resolvePending(requestId) {const record=pending.find(p=>p.request_id===requestId);if(record)await acknowledge(record);},
      async retryPending() {const retry=new Map(pending.map(p=>[p.request_id,p]));await flush();for(const p of pending)retry.set(p.request_id,p);const results=[];for(const p of retry.values()){const r=await execute(p);results.push(r);if(!r.response.ok)break;}return results;},
      transition(next) {if(transition)return;transition=next;retryTransition();},retryTransition,
      get transitionPending(){return !!transition;},get storageError(){return persistenceError;},
      onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      async avatar(id) {const n=safeUserId(id);if(n===null)return null;if(!avatars.has(n))avatars.set(n,sdk.user.getById(n,{timeoutMs:15000}).then(u=>typeof u.avatarUrl==='string'&&u.avatarUrl.startsWith('blob:')?u.avatarUrl:null).catch(()=>null));return avatars.get(n);},
      openLink:url=>sdk.links.open(url),
      async fullscreen(){const state=await sdk.fullscreen[fullscreen?'exit':'request']();fullscreen=state.active;},
      reload:()=>root.location.reload(),
    };
    return host;
  }
  const exports = {createMiniAppHost,safeUserId,route};
  root.GameHosts=exports;
  if (typeof module!=='undefined' && module.exports) module.exports=exports;
  if (root.document && !root.miniApp) root.GameHost={isMiniApp:false,storage:{getItem:key=>root.localStorage.getItem(key),setItem:(key,value)=>root.localStorage.setItem(key,value),removeItem:key=>root.localStorage.removeItem(key)},flush:()=>Promise.resolve(),
    openLink:url=>root.open(url,'_blank','noopener,noreferrer'),reload:()=>root.location.reload()};
})(globalThis);
