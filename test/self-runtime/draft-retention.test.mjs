import {test} from 'node:test';
import assert from 'node:assert/strict';
import {H,D,iso,world} from '../support/schedule-world.mjs';
import {processSelfJobs} from '../../worker/self-service/ingestion.mjs';
import {seal,tokenKey} from '../../worker/self-service/crypto.mjs';

// A fetched review is only worth drafting while its text is kept (7 days from
// the fetch): a later draft can never be delivered, so it must not spend Groq
// or the monthly draft budget, even when a delayed purge has not erased it yet.
async function seedFetched(ctx,store,id,createdAt){
 const review={name:'架空利用者',text:'良かったです',rating:5,createTime:iso(createdAt),updateTime:iso(createdAt)};
 await ctx.db.prepare("INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES (?,?,?,'fixture',?,'fetched',?,0,?,?)")
  .bind(id,store.id,id,store.generation,await seal(JSON.stringify(review),tokenKey(ctx),'job:'+id),createdAt,createdAt).run();
}
test('a fetched review past the 7-day keep is never drafted, even before the purge erases it',async t=>{
 const T0=Date.parse('2026-10-06T01:10:00Z'); // JST 10:10, a draft slot
 const w=await world(t,{n:1,T0});const [a]=w.stores;
 await seedFetched(w.ctx,a,'old',T0-7*D-H);
 await seedFetched(w.ctx,a,'fresh',T0-H);
 for(let i=0;i<3;i++)await processSelfJobs(w.ctx,{limit:1});
 assert.equal(w.log.groq,1,'only the fresh review reaches Groq');
 const stages=Object.fromEntries((await w.db.prepare('SELECT id,stage FROM review_jobs').all()).results.map(r=>[r.id,r.stage]));
 assert.equal(stages.fresh,'draft_ready');
 assert.equal(stages.old,'fetched','the stale review is left for the purge');
 assert.equal((await w.db.prepare("SELECT count(*) n FROM replies WHERE job_id='old'").first()).n,0);
});
