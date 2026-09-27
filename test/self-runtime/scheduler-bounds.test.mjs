import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {seedGoogleCredential} from '../support/self-google.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {claimLocation} from '../../worker/self-service/store-repository.mjs';
import {runSelfScheduled} from '../../worker/self-service/scheduled.mjs';
import {pollSelfStore,processSelfJobs} from '../../worker/self-service/ingestion.mjs';
import {draftBudgetScope,budgetStatement} from '../../worker/self-service/budget.mjs';
import {seal,sha256,tokenKey} from '../../worker/self-service/crypto.mjs';
const base=Date.parse('2026-09-27T02:00:00Z');
async function setup(t){const {db}=await withD1(t);await applySchema(db);return db;}
function meterD1(db, failBatch=()=>false) {
 const stats={calls:0,statements:0};const original=new WeakMap();
 function wrap(stmt){const out={bind:(...args)=>wrap(stmt.bind(...args))};
  for(const method of ['first','all','run','raw'])out[method]=(...args)=>{stats.calls++;stats.statements++;return stmt[method](...args);};
  original.set(out,stmt);return out;
 }
 return {stats,db:{prepare:sql=>wrap(db.prepare(sql)),batch:statements=>{
  stats.calls++;stats.statements+=statements.length;
  if(failBatch())throw Error('fixture storage unavailable');
  return db.batch(statements.map(s=>original.get(s)??s));
 }}};
}
async function seedAbandoned(ctx){
 await claimLocation(ctx,{sub:'abandoned',accountId:'accounts/1',locationId:'locations/999',title:'架空店'});
 await ctx.db.prepare('UPDATE stores SET updated_at=? WHERE owner_sub=?').bind(ctx.now()-2*86400000,'abandoned').run();
}
async function seedReply(ctx,store,id,state='pending'){
 const review={name:'架空利用者',text:'良かったです',rating:5,createTime:new Date(base).toISOString(),updateTime:new Date(base).toISOString()};
 await ctx.db.prepare("INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,1,?,?,0,?,?)")
  .bind(id,store.id,id,'fixture-version',state==='pending'?'draft_ready':'post_unknown',await seal(JSON.stringify(review),tokenKey(ctx),'job:'+id),ctx.now(),ctx.now()).run();
 await ctx.db.prepare('INSERT INTO replies VALUES (?,?,?,1,?,?,?,?)')
  .bind('ss_'+id,id,store.id,await seal('ご来店ありがとうございました。',tokenKey(ctx),'reply:ss_'+id),await sha256('ご来店ありがとうございました。'),state,ctx.now()+86400000).run();
}
test('scheduled cleanup handles one expired registration per invocation',async t=>{
 const db=await setup(t);let now=base;
 const ctx=createSelfContext(fixtureEnv(db,{SELF_PROCESSING_ENABLED:'false'}),{now:()=>now});
 for(let i=0;i<3;i++)await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+(i+1),title:'架空店'});
 now+=2*86400000;
 for(let remaining=2;remaining>=0;remaining--){await runSelfScheduled(ctx);assert.equal((await db.prepare('SELECT count(*) n FROM stores').first()).n,remaining);}
});
test('failed polling rotates past the first store and notification hours do not poll Google',async t=>{
 const db=await setup(t);let now=base;const calls=[];
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
 now+=3600000;calls.length=0;await runSelfScheduled(ctx);
 assert.deepEqual(calls,[]);
 assert.equal((await db.prepare('SELECT count(*) n FROM stores WHERE last_polled_at IS NOT NULL').first()).n,1);
 now+=3600000;await runSelfScheduled(ctx);
 assert.equal((await db.prepare('SELECT count(*) n FROM stores WHERE last_polled_at IS NOT NULL').first()).n,2);
});
test('even-hour cleanup, two-page poll and three failed AI saves stay bounded and retain consumption',async t=>{
 const db=await setup(t);let ai=0,pages=0,saveFailures=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>base,fetchImpl:async u=>{
  const url=new URL(u);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
  if(url.hostname==='api.groq.com'){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  assert.equal(url.hostname,'mybusiness.googleapis.com');pages++;
  return Response.json({reviews:[{reviewId:'review'+pages,starRating:'FIVE',comment:'良かったです',createTime:new Date(base).toISOString()}],...(pages===1?{nextPageToken:'second'}:{})});
 }});
 await seedStore(ctx);await seedGoogleCredential(ctx);await seedAbandoned(ctx);
 const meter=meterD1(db,()=>ai>0&&saveFailures++<3);ctx.db=meter.db;
 await runSelfScheduled(ctx);
 assert.equal(ai,1);assert.equal(pages,2);assert.equal(saveFailures,3);
 assert.equal((await db.prepare("SELECT count(*) n FROM review_jobs WHERE stage='draft_storage_held'").first()).n,1);
 assert.equal((await db.prepare("SELECT used FROM usage_budgets WHERE kind='draft'").first()).used,1);
 assert.equal((await db.prepare("SELECT state FROM usage_reservations WHERE kind='draft'").first()).state,'committed');
 assert.equal(await db.prepare("SELECT id FROM stores WHERE owner_sub='abandoned'").first(),null);
 assert.ok(meter.stats.calls<=40,JSON.stringify(meter.stats));t.diagnostic(JSON.stringify(meter.stats));
});
for(const failure of ['429','timeout','accepted-save-failure'])test('odd-hour cleanup, LINE '+failure+' and reply reconciliation stay bounded',async t=>{
 const db=await setup(t);let pushes=0,gets=0,savedFailures=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>base+3600000,fetchImpl:async (u,init={})=>{
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
 const meter=meterD1(db,()=>failure==='accepted-save-failure'&&pushes>0&&savedFailures++===0);ctx.db=meter.db;
 await runSelfScheduled(ctx);
 assert.equal(pushes,1);assert.equal(gets,1);
 const notification=await db.prepare('SELECT state,lease_id,attempt_no,next_attempt_at FROM notification_jobs').first();
 assert.equal(notification.state,'pending');assert.equal(notification.lease_id,null);
 if(failure==='429'){assert.equal(notification.attempt_no,1);assert.ok(notification.next_attempt_at>ctx.now());}
 assert.equal((await db.prepare("SELECT state FROM usage_reservations WHERE kind='push'").first()).state,failure==='429'?'released':failure==='timeout'?'uncertain':'committed');
 assert.equal((await db.prepare("SELECT state FROM replies WHERE id='ss_unknown'").first()).state,'posted');
 assert.ok(meter.stats.calls<=40,JSON.stringify(meter.stats));t.diagnostic(JSON.stringify(meter.stats));
});
test('five active stores each get a notification turn without Google list polling',async t=>{
 const db=await setup(t);let now=base+3600000;const recipients=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_MAX_ACTIVE_STORES:'5',SELF_MONTHLY_PUSH_LIMIT:'20'}),{now:()=>now,fetchImpl:async(u,init={})=>{
  const url=new URL(u);assert.equal(url.hostname,'api.line.me');
  if(url.pathname.endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(url.pathname.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert.ok(url.pathname.endsWith('/push'));recipients.push(JSON.parse(init.body).to);return Response.json({});
 }});
 for(let i=0;i<5;i++){
  const store=await claimLocation(ctx,{sub:'owner'+i,accountId:'accounts/1',locationId:'locations/'+i,title:'架空店'});
  await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1',line_user_id=? WHERE id=?").bind('line-'+i,store.id).run();
  await seedReply(ctx,store,'review-'+i);
 }
 for(let i=0;i<5;i++){const meter=meterD1(db);ctx.db=meter.db;await runSelfScheduled(ctx);assert.ok(meter.stats.calls<=40);now+=2*3600000;}
 assert.deepEqual(recipients.sort(),['line-0','line-1','line-2','line-3','line-4']);
});
test('quota-held oldest job yields to another store and retries on the next month',async t=>{
 const db=await setup(t);let now=base,ai=0;
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now,fetchImpl:async u=>{
  if(String(u).includes('oauth2.googleapis.com'))return Response.json({access_token:'fixture'});
  if(String(u).includes('api.groq.com')){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  return Response.json({reviews:[{reviewId:'review',starRating:'FIVE',comment:'よかったです',createTime:new Date(base).toISOString(),reviewer:{displayName:'架空利用者'}}]});
 }});
 const a=await seedStore(ctx);await seedGoogleCredential(ctx);await pollSelfStore(ctx,a.id);
 const b=await claimLocation(ctx,{sub:'bob',accountId:'accounts/1',locationId:'locations/3',title:'架空B'});
 await db.prepare("UPDATE stores SET state='active',terms_version='fixture-v1' WHERE id=?").bind(b.id).run();
 await seedGoogleCredential(ctx,'bob');now++;
 await pollSelfStore(ctx,b.id);
 await budgetStatement(ctx,{scope:await draftBudgetScope(ctx,a),period:'2026-09',kind:'draft',cap:1}).run();
 await db.prepare("UPDATE usage_budgets SET used=1 WHERE scope=?").bind(await draftBudgetScope(ctx,a)).run();
 await processSelfJobs(ctx,{limit:1});assert.equal(ai,0);
 const held=await db.prepare('SELECT next_attempt_at FROM review_jobs WHERE store_id=?').bind(a.id).first();
 assert.equal(held.next_attempt_at,Date.parse('2026-10-01T00:00:00Z')-9*3600000);
 now+=2*3600000;await processSelfJobs(ctx,{limit:1});assert.equal(ai,1);
 now=held.next_attempt_at+1;await pollSelfStore(ctx,a.id);await processSelfJobs(ctx,{limit:1});assert.equal(ai,2);
});
