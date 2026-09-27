import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {seedGoogleCredential} from '../support/self-google.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
import {pollSelfStore} from '../../worker/self-service/ingestion.mjs';
import {draftBudgetScope} from '../../worker/self-service/budget.mjs';
import {processSelfJobs} from '../../worker/self-service/ingestion.mjs';
import {activateStore} from '../../worker/self-service/lifecycle.mjs';
const day=86400000,base=Date.parse('2026-09-01T02:00:00Z');
async function setup(t,state='active'){
 const {db}=await withD1(t);await applySchema(db);let now=base;const calls=[];
 const ctx=createSelfContext(fixtureEnv(db),{now:()=>now,fetchImpl:async u=>{
  const url=new URL(u);calls.push(url.hostname);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
  if(url.hostname==='mybusinessaccountmanagement.googleapis.com')return Response.json({name:'accounts/1'});
  if(url.hostname==='mybusinessbusinessinformation.googleapis.com')return Response.json({name:'locations/2',title:'新しい店舗名'});
  return Response.json({reviews:[]});
 }});
 const store=await seedStore(ctx,{state});await seedGoogleCredential(ctx);
 return {ctx,db,store,calls,time:n=>{now=n;}};
}
test('API metadata cache is refreshed by real reads, not ordinary account operations',async t=>{
 const {ctx,db,store,calls,time}=await setup(t);
 time(base+8*day);await pollSelfStore(ctx,store.id);
 const row=await db.prepare('SELECT title,metadata_fetched_at FROM stores WHERE id=?').bind(store.id).first();
 assert.equal(row.title,'新しい店舗名');assert.equal(row.metadata_fetched_at,ctx.now());
 assert.ok(calls.includes('mybusinessaccountmanagement.googleapis.com'));
 assert.ok(calls.includes('mybusinessbusinessinformation.googleapis.com'));
});
test('paused and processing-closed registrations expire without external reads after 21 days',async t=>{
 const {ctx,db,store,calls,time}=await setup(t,'paused');ctx.env.SELF_PROCESSING_ENABLED='false';
 time(base+21*day-1);await purgeExpired(ctx);assert.ok(await db.prepare('SELECT id FROM stores').first());
 time(base+21*day+1);await purgeExpired(ctx);
 for(const table of ['stores','google_credentials','location_claims'])assert.equal((await db.prepare('SELECT count(*) n FROM '+table).first()).n,0,table);
 assert.equal(calls.length,0);
});
test('failed metadata refetch does not extend cache lifetime',async t=>{
 const {ctx,db,store,time}=await setup(t);time(base+8*day);
 ctx.fetchImpl=async u=>String(u).includes('/token')?Response.json({access_token:'fixture'}):Response.json({}, {status:503});
 await assert.rejects(pollSelfStore(ctx,store.id));
 assert.equal((await db.prepare('SELECT metadata_fetched_at FROM stores').first()).metadata_fetched_at,base);
});
test('successful refetch wins a concurrent expiry cleanup atomically',async t=>{
 const {ctx,db,store,time}=await setup(t);time(base+21*day+1);let raced=false;
 const raceDb={prepare:db.prepare.bind(db),batch:async statements=>{
  if(!raced){raced=true;await db.prepare('UPDATE stores SET metadata_fetched_at=? WHERE id=?').bind(ctx.now(),store.id).run();}
  return db.batch(statements);
 }};
 await purgeExpired({...ctx,db:raceDb});assert.equal(raced,true);
 assert.ok(await db.prepare('SELECT id FROM stores WHERE id=?').bind(store.id).first());
 assert.ok(await db.prepare('SELECT owner_sub FROM google_credentials').first());
});
test('monthly operational budget scope is keyed, owner-independent and month-specific',async t=>{
 const {ctx,store}=await setup(t);
 const a=await draftBudgetScope(ctx,store,'2026-09');
 const b=await draftBudgetScope(ctx,{...store,ownerSub:'bob'},'2026-09');
 assert.equal(a,b);assert.ok(!a.includes('locations/2'));assert.match(a,/^draft-v2:/);
 assert.notEqual(a,await draftBudgetScope(ctx,store,'2026-10'));
});
test('21-day cache cleanup removes raw review identifiers while preserving deduplication',async t=>{
 const {ctx,db,store,time}=await setup(t);let ai=0;
 ctx.fetchImpl=async u=>{
  if(String(u).includes('/token'))return Response.json({access_token:'fixture'});
  if(String(u).includes('api.groq.com')){ai++;return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});}
  return Response.json({reviews:[{reviewId:'raw-review',comment:'良かったです',starRating:'FIVE',createTime:new Date(base).toISOString()}]});
 };
 await pollSelfStore(ctx,store.id);await processSelfJobs(ctx);assert.equal(ai,1);
 const original=await db.prepare('SELECT id FROM review_jobs').first();
 time(base+22*day);
 // A fresh metadata fetch is independent of the old review acquisition time.
 await db.prepare('UPDATE stores SET metadata_fetched_at=?').bind(ctx.now()).run();
 await purgeExpired(ctx);
 const job=await db.prepare('SELECT * FROM review_jobs').first();
 assert.equal(job.id,original.id);assert.equal(job.review_id,'expired:'+job.id);
 assert.equal(job.payload_ciphertext,null);
 const reply=await db.prepare('SELECT * FROM replies').first();assert.equal(reply.draft_hash,'');
 await pollSelfStore(ctx,store.id);await processSelfJobs(ctx);assert.equal(ai,1);
 assert.equal((await db.prepare('SELECT count(*) n FROM review_jobs').first()).n,1);
 time(base+71*day);await db.prepare('UPDATE stores SET metadata_fetched_at=?').bind(ctx.now()).run();
 await purgeExpired(ctx);await pollSelfStore(ctx,store.id);await processSelfJobs(ctx);
 assert.equal(ai,1,'expired dedup tokens cannot recreate a review outside the rolling 60-day window');
 assert.equal((await db.prepare('SELECT count(*) n FROM review_jobs').first()).n,0);
 assert.equal((await db.prepare('SELECT count(*) n FROM replies').first()).n,0);
});
test('raw draft ledgers migrate without resetting or double-counting and expire after settlement',async t=>{
 const {ctx,db,store,time}=await setup(t);
 const scope=await draftBudgetScope(ctx,store);
 await db.prepare("INSERT INTO usage_budgets VALUES ('location:locations/2','2026-09','draft',9,0)").run();
 await db.prepare("INSERT INTO usage_reservations VALUES ('old-attempt','location:locations/2','2026-09','draft',1,'committed',?)").bind(base).run();
 await db.prepare("INSERT INTO usage_budgets VALUES (?,'2026-09','draft',9,1)").bind(scope).run();
 await purgeExpired(ctx);await purgeExpired(ctx);
 assert.equal((await db.prepare('SELECT used FROM usage_budgets WHERE scope=?').bind(scope).first()).used,2);
 assert.equal((await db.prepare('SELECT scope FROM usage_reservations').first()).scope,scope);
 assert.equal(await db.prepare("SELECT scope FROM usage_budgets WHERE scope LIKE 'location:%'").first(),null);
 time(Date.parse('2026-10-07T14:59:59Z'));await db.prepare('UPDATE stores SET metadata_fetched_at=?').bind(ctx.now()).run();await purgeExpired(ctx);
 assert.ok(await db.prepare('SELECT id FROM usage_reservations').first());
 time(Date.parse('2026-10-08T00:00:01+09:00'));await purgeExpired(ctx);
 assert.equal((await db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
 assert.equal((await db.prepare('SELECT count(*) n FROM usage_budgets').first()).n,0);
});
test('unknown migration cache age is not fabricated as a fresh API acquisition',async t=>{
 const {ctx,db}=await setup(t);await db.prepare('UPDATE stores SET metadata_fetched_at=NULL').run();
 await purgeExpired(ctx);assert.equal((await db.prepare('SELECT count(*) n FROM stores').first()).n,0);
});
test('resume just before cache expiry refreshes metadata before activation succeeds',async t=>{
 const {ctx,db,time}=await setup(t,'paused');time(base+21*day-1000);
 await activateStore(ctx,{sub:'alice'},{confirmed:true,termsVersion:'fixture-v1'});
 time(base+21*day+1000);await purgeExpired(ctx);
 const s=await db.prepare('SELECT state,title,metadata_fetched_at FROM stores').first();
 assert.ok(s);assert.equal(s.state,'active');assert.equal(s.title,'新しい店舗名');
 assert.equal(s.metadata_fetched_at,base+21*day-1000);
});
