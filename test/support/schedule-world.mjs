// Time-stepped harness for the 5-minute scheduler: a miniflare D1 with fake
// Google (per-location review lists), Groq and LINE, metered per slot.
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv} from './self-runtime.mjs';
import {seedGoogleCredential} from './self-google.mjs';
import {meterD1} from './d1-meter.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {claimLocation,getStore} from '../../worker/self-service/store-repository.mjs';
import {runSelfScheduled} from '../../worker/self-service/scheduled.mjs';
import {seal,sha256,tokenKey} from '../../worker/self-service/crypto.mjs';

export const H=3600000,M=60000,SLOT=5*M;
export const jstHour=t=>new Date(t+9*H).getUTCHours();
export const jstDay=t=>new Date(t+9*H).toISOString().slice(0,10);
export const iso=t=>new Date(t).toISOString();

export async function world(t,{n,T0,env={},reviewsFor=()=>[],lineStatus=()=>200,quota=()=>({type:'limited',value:100000})}){
 const {db}=await withD1(t);await applySchema(db);
 const clock={now:T0};
 const log={groq:0,google:0,googleList:[],quotaGets:0,line:0,pushes:[]};
 const ctx=createSelfContext(fixtureEnv(db,{SELF_MAX_ACTIVE_STORES:String(Math.max(n,1)),SELF_MONTHLY_DRAFT_LIMIT:'30',SELF_MONTHLY_PUSH_LIMIT:'1000',...env}),{now:()=>clock.now,fetchImpl:async(u,init={})=>{
  const url=new URL(u);
  if(url.hostname==='oauth2.googleapis.com'){log.google++;return Response.json({access_token:'fixture'});}
  if(url.hostname==='mybusinessaccountmanagement.googleapis.com'){log.google++;return Response.json({name:'accounts/1'});}
  if(url.hostname==='mybusinessbusinessinformation.googleapis.com'){log.google++;return Response.json({name:url.pathname.replace('/v1/',''),title:'架空店'});}
  if(url.hostname==='mybusiness.googleapis.com'){
   log.google++;
   const loc=Number(url.pathname.match(/\/locations\/(\d+)\/reviews$/)[1]);
   const size=Number(url.searchParams.get('pageSize')),offset=Number(url.searchParams.get('pageToken')??0);
   log.googleList.push({loc,at:clock.now,pageToken:url.searchParams.get('pageToken'),size});
   const all=reviewsFor(loc,clock.now).filter(r=>Date.parse(r.createTime)<=clock.now).sort((a,b)=>Date.parse(b.updateTime)-Date.parse(a.updateTime));
   return Response.json({reviews:all.slice(offset,offset+size),...(offset+size<all.length?{nextPageToken:String(offset+size)}:{})});
  }
  if(url.hostname==='api.groq.com'){log.groq++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  assert.equal(url.hostname,'api.line.me');log.line++;
  if(url.pathname.endsWith('/quota')){log.quotaGets++;return Response.json(quota());}
  if(url.pathname.endsWith('/consumption'))return Response.json({totalUsage:log.pushes.length});
  assert.ok(url.pathname.endsWith('/push'));
  const status=lineStatus(clock.now);
  if(status===200)log.pushes.push({to:JSON.parse(init.body).to,at:clock.now});
  return Response.json({},{status});
 }});
 const stores=[];
 for(let i=0;i<n;i++){
  const s=await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+(i+1),title:'架空店'+i});
  await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1',line_user_id=?,line_verified_at=?,metadata_fetched_at=? WHERE id=?").bind('line-'+i,T0,T0,s.id).run();
  await seedGoogleCredential(ctx,'owner'+i);
  stores.push(await getStore(ctx,s.id));
 }
 const worst={};
 async function slot(time){
  clock.now=time;const meter=meterD1(db);ctx.db=meter.db;
  let result;
  try{result=await runSelfScheduled(ctx,{scheduledTime:time});}finally{ctx.db=db;}
  assert.ok(meter.stats.calls<=40&&meter.stats.statements<=50,iso(time)+' '+JSON.stringify({result,...meter.stats}));
  const key=result.role+(result.fallback?'>'+result.fallback:'');
  const w=worst[key]??={calls:0,statements:0,runs:0};
  w.calls=Math.max(w.calls,meter.stats.calls);w.statements=Math.max(w.statements,meter.stats.statements);w.runs++;
  return result;
 }
 async function runUntil(end){for(let time=Math.ceil(clock.now/SLOT)*SLOT;time<=end;time+=SLOT)await slot(time);}
 return {db,ctx,clock,log,stores,slot,runUntil,worst};
}
export async function seedDraft(ctx,store,id,createdAt){
 const review={name:'架空利用者',text:'良かったです',rating:5,createTime:iso(createdAt),updateTime:iso(createdAt)};
 await ctx.db.prepare("INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES (?,?,?,'fixture',?,'draft_ready',?,0,?,?)")
  .bind(id,store.id,id,store.generation,await seal(JSON.stringify(review),tokenKey(ctx),'job:'+id),createdAt,createdAt).run();
 await ctx.db.prepare("INSERT INTO replies VALUES (?,?,?,?,?,?,'pending',?)")
  .bind('ss_'+id,id,store.id,store.generation,await seal('ご来店ありがとうございました。',tokenKey(ctx),'reply:ss_'+id),await sha256('ご来店ありがとうございました。'),createdAt+7*86400000).run();
}
export const tenReviews=T0=>(loc)=>Array.from({length:10},(_,k)=>({reviewId:'r'+loc+'-'+k,starRating:'FIVE',comment:'良かったです'+k,reviewer:{displayName:'架空利用者'},createTime:iso(T0-(k+1)*H),updateTime:iso(T0-(k+1)*H)}));
export async function deliveryInvariants(w){
 for(const p of w.log.pushes)assert.ok(jstHour(p.at)>=9,'no push before JST 09:00: '+iso(p.at));
 const perDay=new Map();
 for(const p of w.log.pushes){const k=p.to+'@'+jstDay(p.at);perDay.set(k,(perDay.get(k)??0)+1);}
 for(const [k,c] of perDay)assert.equal(c,1,'one LINE per store per JST day: '+k);
 const items=(await w.db.prepare('SELECT j.id,count(i.reply_id) c FROM notification_jobs j LEFT JOIN notification_items i ON i.notification_id=j.id GROUP BY j.id').all()).results;
 for(const row of items)assert.ok(row.c>=1&&row.c<=5,JSON.stringify(row));
 assert.equal(w.log.groq,(await w.db.prepare('SELECT count(*) n FROM replies').first()).n,'one Groq call per stored draft');
 assert.equal(w.log.quotaGets,w.log.pushes.length,'a quota check is only made for a store that is then sent');
}
