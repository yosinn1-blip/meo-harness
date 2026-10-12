import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {seedGoogleCredential} from '../support/self-google.mjs';
import {meterD1} from '../support/d1-meter.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {claimLocation} from '../../worker/self-service/store-repository.mjs';
import {runSelfScheduled} from '../../worker/self-service/scheduled.mjs';
import {pollSelfStore,processSelfJobs} from '../../worker/self-service/ingestion.mjs';
import {draftBudgetScope,budgetStatement} from '../../worker/self-service/budget.mjs';
import {seal,sha256,tokenKey} from '../../worker/self-service/crypto.mjs';
// 02:00Z = JST 11:00. Roles come from the UTC minute: :00 cleanup, :05/:35 poll,
// :10/:20/:30/:40/:50 draft, :15/:45/:55 notify, :25 settle.
const base=Date.parse('2026-09-27T02:00:00Z');
const at=minutes=>base+minutes*60000;
async function setup(t){const {db}=await withD1(t);await applySchema(db);return db;}
function bounded(t,stats){
 assert.ok(stats.calls<=40,JSON.stringify(stats));
 assert.ok(stats.statements<=50,JSON.stringify(stats));
 t.diagnostic(JSON.stringify(stats));
}
async function seedAbandoned(ctx){
 await claimLocation(ctx,{sub:'abandoned',accountId:'accounts/1',locationId:'locations/999',title:'架空店'});
 await ctx.db.prepare('UPDATE stores SET created_at=?,updated_at=? WHERE owner_sub=?').bind(ctx.now()-2*86400000,ctx.now()-2*86400000,'abandoned').run();
}
async function seedReply(ctx,store,id,state='pending',createdAt=ctx.now()-2*3600000){
 const review={name:'架空利用者',text:'良かったです',rating:5,createTime:new Date(base).toISOString(),updateTime:new Date(base).toISOString()};
 await ctx.db.prepare("INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,1,?,?,0,?,?)")
  .bind(id,store.id,id,'fixture-version',state==='pending'?'draft_ready':'post_unknown',await seal(JSON.stringify(review),tokenKey(ctx),'job:'+id),createdAt,createdAt).run();
 await ctx.db.prepare('INSERT INTO replies VALUES (?,?,?,1,?,?,?,?)')
  .bind('ss_'+id,id,store.id,await seal('ご来店ありがとうございました。',tokenKey(ctx),'reply:ss_'+id),await sha256('ご来店ありがとうございました。'),state,ctx.now()+86400000).run();
}
test('scheduled cleanup handles one expired registration per invocation',async t=>{
 const db=await setup(t);let now=base;
 const ctx=createSelfContext(fixtureEnv(db,{SELF_PROCESSING_ENABLED:'false'}),{now:()=>now});
 for(let i=0;i<3;i++)await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+(i+1),title:'架空店'});
 now+=2*86400000;
 for(let remaining=2;remaining>=0;remaining--){
  const meter=meterD1(db);ctx.db=meter.db;
  await runSelfScheduled(ctx);ctx.db=db;bounded(t,meter.stats);
  assert.equal((await db.prepare('SELECT count(*) n FROM stores').first()).n,remaining);
  now+=3600000; // the next :00 cleanup slot
 }
});
test('failed polling rotates past the first store and notification slots do not poll Google',async t=>{
 const db=await setup(t);let now=at(5);const calls=[];
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now,fetchImpl:async u=>{calls.push(String(u));throw Error('fixture unavailable');}});
 const stores=[];
 for(let i=0;i<3;i++){
  const s=await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+(i+1),title:'架空店'});
  await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1' WHERE id=?").bind(s.id).run();stores.push(s);
  await seedGoogleCredential(ctx,'owner'+i);
 }
 await runSelfScheduled(ctx);
 assert.equal(calls.length,1,'failed token provider is genuinely exercised');
 assert.equal((await db.prepare('SELECT count(*) n FROM stores WHERE last_polled_at IS NOT NULL').first()).n,1);
 now=at(15);calls.length=0;await runSelfScheduled(ctx);
 assert.deepEqual(calls,[]);
 assert.equal((await db.prepare('SELECT count(*) n FROM stores WHERE last_polled_at IS NOT NULL').first()).n,1);
 now=at(35);await runSelfScheduled(ctx);
 assert.equal(calls.length,1,'the failed store waits its two-hour interval; the next store is polled');
 assert.equal((await db.prepare('SELECT count(*) n FROM stores WHERE last_polled_at IS NOT NULL').first()).n,2);
});
test(':00 cleanup that deletes an abandoned store stays bounded and defers general cleanup',async t=>{
 const db=await setup(t);let now=base;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
 await seedAbandoned(ctx);
 await db.prepare("INSERT INTO sessions(token_hash,owner_sub,csrf,expires_at,created_at) VALUES ('expired-session',NULL,'csrf',?,?)").bind(now-1,now-86400000).run();
 const meter=meterD1(db);ctx.db=meter.db;
 await runSelfScheduled(ctx);ctx.db=db;bounded(t,meter.stats);
 assert.equal(await db.prepare("SELECT id FROM stores WHERE owner_sub='abandoned'").first(),null);
 assert.ok(await db.prepare("SELECT 1 FROM sessions WHERE token_hash='expired-session'").first(),'general cleanup waits for the next :00');
 now+=3600000;await runSelfScheduled(ctx);
 assert.equal(await db.prepare("SELECT 1 FROM sessions WHERE token_hash='expired-session'").first(),null);
});
test(':05 poll reads one twenty-review page, keeps the page token and does not draft',async t=>{
 const db=await setup(t);let ai=0,pages=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>at(5),fetchImpl:async (u)=>{
  const url=new URL(u);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
  if(url.hostname==='mybusinessaccountmanagement.googleapis.com')return Response.json({name:'accounts/1'});
  if(url.hostname==='mybusinessbusinessinformation.googleapis.com')return Response.json({name:'locations/2',title:'架空店'});
  if(url.hostname==='api.groq.com'){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  assert.equal(url.hostname,'mybusiness.googleapis.com');pages++;
  assert.equal(url.searchParams.get('pageSize'),'20');
  return Response.json({reviews:Array.from({length:20},(_,i)=>({reviewId:'review'+i,starRating:'FIVE',comment:'良かったです'+i,createTime:new Date(base-i*1000).toISOString(),updateTime:new Date(base-i*1000).toISOString()})),nextPageToken:'second'});
 }});
 await seedStore(ctx);await seedGoogleCredential(ctx);
 const meter=meterD1(db);ctx.db=meter.db;
 await runSelfScheduled(ctx);ctx.db=db;bounded(t,meter.stats);
 assert.equal(pages,1);assert.equal(ai,0);
 assert.equal((await db.prepare('SELECT count(*) n FROM review_jobs').first()).n,20);
 assert.equal((await db.prepare('SELECT page_token FROM poll_cursors').first()).page_token,'second');
});
test(':10 draft with three failed AI saves stays bounded and retains consumption',async t=>{
 const db=await setup(t);let ai=0,saveFailures=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>at(10),fetchImpl:async u=>{
  const url=new URL(u);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
  if(url.hostname==='mybusinessaccountmanagement.googleapis.com')return Response.json({name:'accounts/1'});
  if(url.hostname==='mybusinessbusinessinformation.googleapis.com')return Response.json({name:'locations/2',title:'架空店'});
  if(url.hostname==='api.groq.com'){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  return Response.json({reviews:[{reviewId:'review',starRating:'FIVE',comment:'良かったです',createTime:new Date(base).toISOString()}]});
 }});
 const store=await seedStore(ctx);await seedGoogleCredential(ctx);await pollSelfStore(ctx,store.id);
 const meter=meterD1(db,()=>ai>0&&saveFailures++<3);ctx.db=meter.db;
 await runSelfScheduled(ctx);ctx.db=db;bounded(t,meter.stats);
 assert.equal(ai,1);assert.equal(saveFailures,3);
 assert.equal((await db.prepare("SELECT count(*) n FROM review_jobs WHERE stage='draft_storage_held'").first()).n,1);
 assert.equal((await db.prepare("SELECT used FROM usage_budgets WHERE kind='draft'").first()).used,1);
 assert.equal((await db.prepare("SELECT state FROM usage_reservations WHERE kind='draft'").first()).state,'committed');
});
for(const failure of ['429','timeout','accepted-save-failure'])test(':15 LINE '+failure+' and :25 reply reconciliation stay bounded',async t=>{
 const db=await setup(t);let pushes=0,gets=0,savedFailures=0,now=at(15);
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now,fetchImpl:async (u,init={})=>{
  const url=new URL(u);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
  if(url.hostname==='mybusiness.googleapis.com'){assert.notEqual(init.method,'PUT');gets++;return Response.json({reviewId:'unknown',reviewReply:{comment:'ご来店ありがとうございました。'}});}
  if(url.pathname.endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(url.pathname.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert.ok(url.pathname.endsWith('/push'));pushes++;
  if(failure==='timeout')throw Error('fixture timeout');
  return Response.json({}, {status:failure==='429'?429:200});
 }});
 const store=await seedStore(ctx);await seedGoogleCredential(ctx);await seedAbandoned(ctx);
 await seedReply(ctx,store,'new');await seedReply(ctx,store,'unknown','post_unknown');
 const meter=meterD1(db,sqls=>failure==='accepted-save-failure'&&pushes>0&&sqls.some(q=>q.includes("state='accepted'"))&&savedFailures++===0);ctx.db=meter.db;
 await runSelfScheduled(ctx);bounded(t,meter.stats);
 assert.equal(pushes,1);assert.equal(gets,0,'the notify slot does not reconcile');
 const notification=await db.prepare('SELECT state,lease_id,attempt_no,next_attempt_at FROM notification_jobs').first();
 assert.equal(notification.state,'pending');assert.equal(notification.lease_id,null);
 if(failure==='429'){assert.equal(notification.attempt_no,1);assert.ok(notification.next_attempt_at>ctx.now());}
 assert.equal((await db.prepare("SELECT state FROM usage_reservations WHERE kind='push'").first()).state,failure==='429'?'released':failure==='timeout'?'uncertain':'committed');
 now=at(25);const settle=meterD1(db);ctx.db=settle.db;
 await runSelfScheduled(ctx);ctx.db=db;bounded(t,settle.stats);
 assert.equal(gets,1);assert.equal(pushes,1);
 assert.equal((await db.prepare("SELECT state FROM replies WHERE id='ss_unknown'").first()).state,'posted');
});
test('five active stores each get a notification turn without Google list polling',async t=>{
 const db=await setup(t);let now=at(15);const recipients=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_MAX_ACTIVE_STORES:'5',SELF_MONTHLY_PUSH_LIMIT:'20'}),{now:()=>now,fetchImpl:async(u,init={})=>{
  const url=new URL(u);assert.equal(url.hostname,'api.line.me');
  if(url.pathname.endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(url.pathname.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert.ok(url.pathname.endsWith('/push'));recipients.push(JSON.parse(init.body).to);return Response.json({});
 }});
 for(let i=0;i<5;i++){
  const store=await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+i,title:'架空店'});
  await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1',line_user_id=? WHERE id=?").bind('line-'+i,store.id).run();
  await seedReply(ctx,store,'review-'+i,'pending',base-3600000);
 }
 for(const minute of [15,45,55,75,105]){now=at(minute);const meter=meterD1(db);ctx.db=meter.db;await runSelfScheduled(ctx);ctx.db=db;bounded(t,meter.stats);}
 assert.deepEqual(recipients.sort(),['line-0','line-1','line-2','line-3','line-4']);
});
test('quota-held store yields all its jobs to another store and retries on the next month',async t=>{
 const db=await setup(t);let now=base,ai=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now,fetchImpl:async u=>{
  if(String(u).includes('oauth2.googleapis.com'))return Response.json({access_token:'fixture'});
  if(String(u).includes('api.groq.com')){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  const count=String(u).includes('/locations/2/')?2:1;
  return Response.json({reviews:Array.from({length:count},(_,i)=>({reviewId:'review'+i,starRating:'FIVE',comment:'よかったです'+i,createTime:new Date(base).toISOString(),reviewer:{displayName:'架空利用者'}}))});
 }});
 const a=await seedStore(ctx);await seedGoogleCredential(ctx);await pollSelfStore(ctx,a.id);
 const b=await claimLocation(ctx,{sub:'bob',accountId:'accounts/1',locationId:'locations/3',title:'架空B'});
 await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1' WHERE id=?").bind(b.id).run();
 await seedGoogleCredential(ctx,'bob');now++;
 await pollSelfStore(ctx,b.id);
 await budgetStatement(ctx,{scope:await draftBudgetScope(ctx,a),period:'2026-09',kind:'draft',cap:1}).run();
 await db.prepare("UPDATE usage_budgets SET used=1 WHERE scope=?").bind(await draftBudgetScope(ctx,a)).run();
 await processSelfJobs(ctx,{limit:1});assert.equal(ai,0);
 const held=(await db.prepare('SELECT next_attempt_at FROM review_jobs WHERE store_id=?').bind(a.id).all()).results;
 assert.equal(held.length,2);
 for(const job of held)assert.equal(job.next_attempt_at,Date.parse('2026-10-01T00:00:00Z')-9*3600000,'every fetched job of the exhausted store moves at once');
 now+=2*3600000;await processSelfJobs(ctx,{limit:1});assert.equal(ai,1);
 now=held[0].next_attempt_at+1;await pollSelfStore(ctx,a.id);await processSelfJobs(ctx,{limit:1});assert.equal(ai,2);
});
