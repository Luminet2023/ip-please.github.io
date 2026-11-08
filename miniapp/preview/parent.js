// Local deterministic fixture, not authentication or backend acceptance.
const user={user_id:'user_preview0000000001',linuxdo_id:'42',display_name:'Fixture Inspector',avatar_url:null,tag:'ABCD'};
const daily={date:'2026-11-08',played:false,in_progress:false,run_id:null,travelers:40,resets_at:1794153600};
const ok=body=>({status:200,headers:{},body});
const missing=()=>({status:404,headers:{},body:{detail:'The requested resource was not found.'}});
const fixture={calls:[],ready:false,failStorage:false,loseNextAction:false,offline:false,account:42,channel:'sandbox',locale:'en',run:null,item:null,cloud:null,receipts:new Map()};
window.preview=fixture;
function run(mode){return {run_id:'run_preview000000001',generator_version:2,inspection_date:'2026.10.25',mode,status:'active',end_reason:null,score:0,travelers:0,processed:0,correct:0,document_reviews:0,model_identity_checks:0,streak:0,best_streak:0,strikes:0,max_strikes:3,multiplier:1,travelers_total:mode==='daily'?40:null,next_kind:'traveler',bulletin:null,wanted:null};}
function traveler(){return {entrant_id:'ent_preview000000001',seq:1,person:'P03',voice:140,intro:[['E','Hello, inspector.',null]],primary:'pp',docs:[{type:'passport',key:'pp',cc:'US',photo:'P03',surname:'MILLER',given:'JAMES',dob:'1984.03.12',sex:'M',iss:'NEW YORK',exp:'2031.07.22'},{type:'device',key:'dv',ip:'72.14.3.9',loc:'美国 · 纽约',tz:'America/New_York',lang:'en-US',device:'MacBook',net:'home'},{type:'account',key:'ac',pay:{brand:'VISA',last4:'1234',virtual:false},bill:'12 Oak St, NY',phone:'+1 212-555-0123'},{type:'entry_permit',key:'ep',holder:'MILLER, JAMES',purpose:'visit',exp:'2027.01.01'}],logins:[],xray:[]};}
async function http(name,o){
 if(fixture.offline)throw Error('Fixture offline');
 const account={...user,user_id:fixture.account===42?user.user_id:'user_preview000000002',linuxdo_id:String(fixture.account)};
 if(name==='bootstrap')return ok({channel:fixture.channel,user:account,announcements:[],daily,active_run:fixture.run});
 if(name==='profile'){if(o.json.id!==String(fixture.account))throw Error('Profile mismatch');return ok(account);}
 if(name==='query'){
  const q=o.query;
  if(q.op==='announcements')return ok({announcements:[{announcement_id:'ann_preview000000001',title:'Preview <safe text>',body:'Local fixture only. Full game assets are loaded from the built package.',level:'info'}]});
  if(q.op==='save')return fixture.cloud?ok(fixture.cloud):missing();
  if(q.op==='snapshots')return ok({user_id:account.user_id,snapshots:fixture.cloud?[{...fixture.cloud,created_at:fixture.cloud.updated_at}]:[]});
  if(q.op==='snapshot')return fixture.cloud?ok(fixture.cloud):missing();
  if(q.op==='daily')return ok({...daily,in_progress:fixture.run?.mode==='daily',run_id:fixture.run?.run_id||null});
  if(q.op==='run_current')return fixture.run?.status==='active'?ok({run:fixture.run,item:fixture.item}):missing();
  if(q.op==='run')return fixture.run?ok({run:fixture.run,final:null}):missing();
  if(q.op==='leaderboard')return ok({board:q.board,period:'all',entries:[{rank:1,linuxdo_id:'42',display_name:'Fixture <Inspector>',avatar_url:null,tag:'ABCD',score:1200,travelers:12,best_streak:6,achieved_at:'2026-11-08T00:00:00.000Z',me:true},{rank:2,linuxdo_id:'9007199254740993',display_name:'Safe fallback',avatar_url:null,tag:'2222',score:1000,travelers:10,best_streak:4,achieved_at:'2026-11-08T01:00:00.000Z',me:false}],me:{rank:1,score:1200,linuxdo_id:'42'}});
 }
 if(name==='action'){
  const a=o.json;if(fixture.receipts.has(a.request_id))return fixture.receipts.get(a.request_id);
  let result;
  if(a.op==='save'){
   if((a.args.base_version||0)!==(fixture.cloud?.version||0))result={status:409,headers:{},body:{detail:'The cloud save has a newer version than the client base version.'}};
   else {fixture.cloud={user_id:account.user_id,save_id:'save_preview000000001',version:(fixture.cloud?.version||0)+1,day:a.args.day,updated_at:'2026-11-08T00:00:00.000Z',payload:a.args.payload};const {payload,...receipt}=fixture.cloud;result=ok(receipt);}
  }else if(a.op==='run_start'){fixture.run=run(a.args.mode);fixture.item=null;result={...ok({run:fixture.run,item:null}),status:201};}
  else if(a.op==='run_next'){fixture.item={item_type:'traveler',entrant:traveler(),progress:{found:[],quiz:null,claims_left:6,locked:false}};result=ok({run:fixture.run,item:fixture.item});}
  else if(a.op==='run_inspect')result=ok({match:false,issue:null,new:false,claims_left:5,locked:false});
  else if(a.op==='run_quiz')result=ok({exposed:false});
  else if(a.op==='run_decision'){
    fixture.run={...fixture.run,score:100,travelers:1,processed:1,correct:1,document_reviews:1,streak:1,best_streak:1};fixture.item=null;
    result=ok({entrant_id:a.args.entrant_id,decision:a.args.decision,correct:true,points:100,breakdown:{base:100,pointing:0,exposed:0,wanted:0,multiplier:1,total:100},reveal:{ok:['approve'],flaws:[],issues:[],liar:false,fish:null,wanted:false,bulletin:false},citation:null,run:fixture.run,final:null});
  }
  else if(a.op==='run_abandon'){fixture.run={...fixture.run,status:'abandoned'};result=ok({run:fixture.run,final:null});}
  else throw Error('Unsupported fixture action '+a.op);
  fixture.receipts.set(a.request_id,structuredClone(result));
  if(fixture.loseNextAction){fixture.loseNextAction=false;throw Error('Fixture lost committed response');}return result;
 }
 throw Error('Unknown fixture endpoint');
}
window.addEventListener('message',async e=>{
 if(e.source!==document.getElementById('app').contentWindow||!e.data?.fixtureCall)return;
 const {id,method,args}=e.data;fixture.calls.push({method,args});
 try{
  let value;
  if(method==='user')value={id:fixture.account,username:'fixture',name:'Fixture Inspector',initials:'FI',trustLevel:1,avatarUrl:null};
  else if(method==='theme')value={mode:'dark',locale:fixture.locale,background:'#161313',text:'#fff',accent:'#e89c74',border:'#5a514b',reducedMotion:false,viewport:{width:innerWidth,height:innerHeight}};
  else if(method==='get')value=localStorage.getItem(fixture.channel+':'+args[0]);
  else if(method==='set'){if(fixture.failStorage)throw Error('Fixture quota');localStorage.setItem(fixture.channel+':'+args[0],args[1]);value=null;}
  else if(method==='http')value=await http(...args);
  else if(method==='asset'){if(!/^assets\/(font|atlas|bg|win)\.png$/.test(args[0]))throw Error('Undeclared asset');value=new Uint8Array(await(await fetch('/web/'+args[0])).arrayBuffer());}
  else if(method==='lookup'){if(!Number.isSafeInteger(args[0]))throw Error('Unsafe SDK user ID');value={id:args[0],name:'Fixture',username:'fixture',initials:'FI',trustLevel:1,avatarUrl:null,avatarBytes:new Uint8Array(await(await fetch('/web/assets/win.png')).arrayBuffer())};}
  else if(method==='ready'){fixture.ready=true;value=null;}
  else if(method==='full')value={active:args[0]};
  else if(method==='link')value=null;
  else throw Error('Unknown fixture method');
  e.source.postMessage({fixtureReply:true,id,value},'*');
 }catch(error){e.source.postMessage({fixtureReply:true,id,error:error.message},'*');}
});
