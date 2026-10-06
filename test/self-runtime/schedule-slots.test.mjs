import {test} from 'node:test';
import assert from 'node:assert/strict';
import {H,M,SLOT,jstDay,iso,world,seedDraft,tenReviews,deliveryInvariants} from '../support/schedule-world.mjs';
import {ROLES,slotRole,legacyCronDue} from '../../worker/self-service/scheduled.mjs';
import {pollSelfStore,processSelfJobs} from '../../worker/self-service/ingestion.mjs';
import {sendSelfDigest} from '../../worker/self-service/notifications.mjs';
import {seal,tokenKey} from '../../worker/self-service/crypto.mjs';
import worker from '../../worker/index.mjs';

test('role table and the legacy gate follow the UTC minute',()=>{
 assert.deepEqual(ROLES,['cleanup','poll','draft','notify','draft','settle','draft','poll','draft','notify','draft','notify']);
 const h=Date.parse('2026-10-06T03:00:00Z');
 assert.deepEqual([0,5,10,15,25,35,45,55].map(m=>slotRole(h+m*M)),['cleanup','poll','draft','notify','settle','poll','notify','notify']);
 assert.equal(slotRole(h+7*M),'poll','a late run keeps its scheduled slot');
 const due=Array.from({length:288},(_,i)=>h+i*SLOT).filter(legacyCronDue);
 assert.equal(due.length,24);
 assert.ok(due.every(x=>new Date(x).getUTCMinutes()===0));
});


test('fair drafting: a store with fewer waiting drafts gets the next draft',async t=>{
 const T0=Date.parse('2026-10-06T01:00:00Z');
 const w=await world(t,{n:2,T0,reviewsFor:loc=>loc===1?tenReviews(T0)(1):[{reviewId:'b',starRating:'FIVE',comment:'良かったです',createTime:iso(T0-1),updateTime:iso(T0-1)}]});
 const [a,b]=w.stores;
 await pollSelfStore(w.ctx,a.id);w.clock.now+=M;await pollSelfStore(w.ctx,b.id);
 await processSelfJobs(w.ctx,{limit:1});await processSelfJobs(w.ctx,{limit:1});
 const owners=(await w.db.prepare('SELECT r.store_id FROM replies r JOIN review_jobs j ON j.id=r.job_id ORDER BY j.updated_at,r.rowid').all()).results.map(r=>r.store_id);
 assert.deepEqual(owners,[a.id,b.id]);
});

test('before JST 09:00 neither a due retry nor a new digest is sent; at 09:15 the due retry goes first',async t=>{
 const T0=Date.parse('2026-10-05T23:55:00Z'); // JST 08:55, a notify slot
 const w=await world(t,{n:2,T0});const [a,b]=w.stores;
 await seedDraft(w.ctx,b,'b-old',T0-20*H);
 await seedDraft(w.ctx,a,'a-1',T0-12*H);
 const id='digest:'+a.id+':2026-10-05';
 await w.db.prepare("INSERT INTO notification_jobs(id,store_id,generation,day_key,part,retry_key,payload_ciphertext,state,first_attempt_at,expires_at,attempt_no,next_attempt_at) VALUES (?,?,?,?,0,?,?,'pending',?,?,1,?)")
  .bind(id,a.id,a.generation,'2026-10-05',crypto.randomUUID(),await seal(JSON.stringify({to:'line-0',messages:[{type:'text',text:'架空'}]}),tokenKey(w.ctx),'notification:'+id),T0-10*H,T0+86400000,T0-M).run();
 await w.db.prepare("INSERT INTO notification_items VALUES (?,?)").bind(id,'ss_a-1').run();
 await w.slot(T0);
 await sendSelfDigest(w.ctx,a.id);await sendSelfDigest(w.ctx,b.id);
 assert.equal(w.log.line,0,'nothing is sent before JST 09:00, retries included');
 await w.slot(T0+20*M); // JST 09:15
 assert.deepEqual(w.log.pushes.map(p=>p.to),['line-0'],'the due retry is chosen before an older waiting draft');
 await w.slot(T0+50*M); // JST 09:45
 assert.deepEqual(w.log.pushes.map(p=>p.to),['line-0','line-1']);
});

test('a retry of yesterday\'s digest accepted today blocks a second digest the same JST day',async t=>{
 const day1=Date.parse('2026-10-05T11:15:00Z'); // JST 20:15, notify slot
 let down=true;
 const w=await world(t,{n:1,T0:day1,lineStatus:()=>down?429:200});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',day1-2*H);
 await w.slot(day1);
 assert.equal(w.log.pushes.length,0);
 assert.equal((await w.db.prepare("SELECT state FROM notification_jobs").first()).state,'pending');
 down=false;
 const day2=Date.parse('2026-10-06T01:15:00Z'); // JST 10:15
 await seedDraft(w.ctx,a,'r2',day2-90*M);
 await w.slot(day2);
 assert.equal(w.log.pushes.length,1,'yesterday\'s digest is retried and accepted today');
 const accepted=await w.db.prepare("SELECT state,day_key,next_attempt_at FROM notification_jobs").first();
 assert.deepEqual([accepted.state,accepted.day_key,accepted.next_attempt_at],['accepted','2026-10-05',day2],'acceptance time is kept in next_attempt_at');
 await w.slot(day2+30*M);await w.slot(day2+40*M);
 await sendSelfDigest(w.ctx,a.id);
 assert.equal(w.log.pushes.length,1,'no second LINE on the same JST day');
 assert.equal((await w.db.prepare("SELECT count(*) n FROM notification_jobs").first()).n,1);
 await w.slot(Date.parse('2026-10-07T00:15:00Z')); // next JST day 09:15
 assert.equal(w.log.pushes.length,2);
});

test('an exhausted LINE quota is re-checked after one hour, not every notify slot',async t=>{
 const T0=Date.parse('2026-10-06T01:15:00Z'); // JST 10:15
 let exhausted=true;
 const w=await world(t,{n:1,T0,quota:()=>({type:'limited',value:exhausted?0:100000})});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',T0-2*H);
 await w.slot(T0);
 assert.equal(w.log.quotaGets,1);assert.equal(w.log.pushes.length,0);
 const held=await w.db.prepare('SELECT state,next_attempt_at,lease_id FROM notification_jobs').first();
 assert.deepEqual([held.state,held.next_attempt_at,held.lease_id],['pending',T0+H,null]);
 for(const m of [5,10,25,30,40,55])await w.slot(T0+m*M);
 assert.equal(w.log.quotaGets,1,'no quota GET while the hold lasts');
 exhausted=false;
 await w.slot(T0+60*M);
 assert.equal(w.log.quotaGets,2);assert.equal(w.log.pushes.length,1);
});

test('a draft fetched less than one hour ago is not notified yet',async t=>{
 const T0=Date.parse('2026-10-06T01:15:00Z'); // JST 10:15
 const w=await world(t,{n:1,T0});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',T0-30*M);
 await w.slot(T0);
 assert.equal(w.log.line,0);
 await w.slot(T0+30*M);
 assert.equal(w.log.pushes.length,1);
});

test('a page whose last review is older than the cutoff ends the scan',async t=>{
 const T0=Date.parse('2026-10-06T01:05:00Z');
 const reviews=Array.from({length:60},(_,k)=>{const time=k<5?T0-k*H:T0-(61+k)*86400000;return {reviewId:'old'+k,starRating:'FIVE',comment:'良かったです',createTime:iso(time),updateTime:iso(time)};});
 const w=await world(t,{n:1,T0,reviewsFor:()=>reviews});const [a]=w.stores;
 await pollSelfStore(w.ctx,a.id);
 const cursor=await w.db.prepare('SELECT page_token,latest_completed_at FROM poll_cursors').first();
 assert.deepEqual([cursor.page_token,cursor.latest_completed_at],[null,T0]);
 assert.equal((await w.db.prepare('SELECT count(*) n FROM review_jobs').first()).n,5);
 w.clock.now+=2*H;await pollSelfStore(w.ctx,a.id);
 assert.deepEqual(w.log.googleList.map(x=>[x.pageToken,x.size]),[[null,20],[null,20]]);
});

test('an empty slot hands over to one fallback job only, within the bounds',async t=>{
 const T0=Date.parse('2026-10-06T01:05:00Z'); // :05 poll, nothing due to poll
 const w=await world(t,{n:1,T0,reviewsFor:tenReviews(T0)});const [a]=w.stores;
 await pollSelfStore(w.ctx,a.id);
 assert.deepEqual(await w.slot(T0+M*0),{role:'poll',did:false,fallback:'draft',fallbackDid:true});
 assert.equal(w.log.groq,1,'the empty poll slot drafts exactly one review');
 // A draft slot with nothing to draft notifies instead (worst: empty draft + 5-item digest).
 const w2=await world(t,{n:1,T0:Date.parse('2026-10-06T01:10:00Z')});
 for(let i=0;i<5;i++)await seedDraft(w2.ctx,w2.stores[0],'d'+i,w2.clock.now-2*H);
 const result=await w2.slot(w2.clock.now);
 assert.deepEqual(result,{role:'draft',did:false,fallback:'notify',fallbackDid:true});
 assert.equal(w2.log.pushes.length,1);
 t.diagnostic('draft>notify '+JSON.stringify(w2.worst));
});

test('legacy KV work runs only in the :00 slot: 24 of 288 runs a day',async t=>{
 const lists=[];let current=null;
 const env={STORES:{
  get:async()=>null,put:async()=>{},delete:async()=>{},
  list:async({prefix})=>{lists.push({prefix,at:current});return {keys:[]};},
 }};
 const day=Date.parse('2026-10-06T00:00:00Z');
 for(let i=0;i<288;i++){current=day+i*SLOT;await worker.scheduled({scheduledTime:current,cron:'*/5 * * * *'},env,{});}
 assert.equal(lists.length,48);
 assert.ok(lists.every(x=>new Date(x.at).getUTCMinutes()===0));
 assert.equal(new Set(lists.map(x=>x.at)).size,24);
 lists.length=0;current=null;
 await worker.scheduled({},env,{});
 assert.deepEqual(lists.map(x=>x.prefix),['pending:','store:'],'a call without scheduledTime keeps the old behaviour');
});
