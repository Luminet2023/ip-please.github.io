'use strict';
const fs=require('node:fs');
const path=require('node:path');
module.exports=async function({page,out,language}){
 const result=await page.evaluate(()=>{
  const cast=['CLAUDE_AI','GPT_AI','QWEN_AI','GROK_AI','GLM_AI','KIMI_AI','GEMINI_AI','MINIMAX_AI','HAIKU','SONNET','OPUS'];
  const expressions=['neutral','talk','smile','grin','nervous','shock','sad','angry'];
  const alphaCanvas=document.createElement('canvas');alphaCanvas.width=180;alphaCanvas.height=128;
  const alphaCtx=alphaCanvas.getContext('2d',{willReadFrequently:true});
  const sheet=document.createElement('canvas');sheet.width=8*203;sheet.height=cast.length*150;
  const ctx=sheet.getContext('2d');ctx.imageSmoothingEnabled=false;
  const frame=document.createElement('canvas');frame.width=640;frame.height=360;
  const frameCtx=frame.getContext('2d');frameCtx.imageSmoothingEnabled=false;
  const savedG=G,savedB=B;const checks=[];
  newGame();scene='booth';startDay();B.xray.on=false;
  for(let row=0;row<cast.length;row++)for(let col=0;col<expressions.length;col++){
   const actor=cast[row],expr=expressions[col],key=actor+':'+expr,s=SPR[key];
   if(!s)throw Error('Missing expression '+key);
   alphaCtx.clearRect(0,0,180,128);
   alphaCtx.drawImage(ATLAS_IMG,s[0],s[1],s[2],s[3],s[4],s[5],s[2],s[3]);
   const pixels=alphaCtx.getImageData(0,0,180,128).data;let transparent=0,black=0;
   for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]<128)transparent++;else if(pixels[i]<12&&pixels[i+1]<12&&pixels[i+2]<12)black++;}
   const transparency=transparent/(180*128),blackRatio=black/(180*128);
   if(transparency<.18||blackRatio>.15)throw Error('Opaque matte in '+key+': '+transparency+' / '+blackRatio);
   B.ent=newEntrant({person:actor,docs:[],ok:['approve']},true);B.ent.expr=expr;B.ent.talkUntil=0;
   setCtx(frameCtx);drawWindow();
   ctx.fillStyle='#24211f';ctx.fillRect(col*203,row*150,203,150);
   ctx.drawImage(frame,WIN[0],WIN[1],WIN_W,WIN_H,col*203,row*150,WIN_W,WIN_H);
   ctx.fillStyle='#fff';ctx.font='11px monospace';ctx.fillText(key,col*203+4,row*150+143);
   checks.push({key,transparency,blackRatio});
  }
  const namedSheet=document.createElement('canvas');namedSheet.width=800;namedSheet.height=750;
  const namedCtx=namedSheet.getContext('2d');namedCtx.imageSmoothingEnabled=false;
  namedCtx.fillStyle='#24211f';namedCtx.fillRect(0,0,800,750);
  const roles=[caseD12AUDIT,caseD13FAMILY,caseD08MINIMAX,caseD13RETIRE,
   ()=>caseD09OtherAppeal(true),()=>caseD09OtherAppeal(true,true),()=>caseD09OtherAppeal(false),
   ()=>{S.family.haiku.gone=true;return caseD13FAMILY();},
   ()=>{S.family.sonnet.gone=true;return caseD13FAMILY();}];
  const named=roles.map((make,index)=>{
   const spec=make();B.ent=newEntrant(spec,true);B.ent.talkUntil=0;
   setCtx(frameCtx);frameCtx.clearRect(0,0,640,360);drawWindow();
   const x=index%2*400,y=Math.floor(index/2)*150;
   namedCtx.fillStyle='#42372f';namedCtx.fillRect(x,y,400,150);
   namedCtx.drawImage(frame,WIN[0],WIN[1],WIN_W,WIN_H,x,y,WIN_W,WIN_H);
   const passport=spec.docs.find(d=>d.doc instanceof Passport)?.doc;
   if(passport){frameCtx.clearRect(0,0,640,360);passport.draw(0,0);namedCtx.drawImage(frame,0,0,passport.w,passport.h,x+213,y,passport.w,passport.h);}
   namedCtx.fillStyle='#fff';namedCtx.font='11px monospace';namedCtx.fillText(spec.caseId+' / '+spec.person,x+4,y+143);
   return {caseId:spec.caseId,person:spec.person,photo:passport?.person};
  });
  setCtx(savedG);B=savedB;
  return {checks,named,image:sheet.toDataURL('image/png'),namedImage:namedSheet.toDataURL('image/png'),version:ASSETS.version};
 });
 fs.writeFileSync(path.join(out,language+'-all-cast.png'),Buffer.from(result.image.split(',')[1],'base64'));
 fs.writeFileSync(path.join(out,language+'-fixed-cast.png'),Buffer.from(result.namedImage.split(',')[1],'base64'));
 delete result.image;delete result.namedImage;
 fs.writeFileSync(path.join(out,language+'-cast-audit.json'),JSON.stringify(result,null,2));
 return result;
};
