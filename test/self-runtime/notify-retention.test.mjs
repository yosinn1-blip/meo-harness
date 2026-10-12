import {test} from 'node:test';
import assert from 'node:assert/strict';
import {H,M,D,world,seedDraft} from '../support/schedule-world.mjs';
import {pickNotifyStore} from '../../worker/self-service/scheduled.mjs';
import {sendSelfDigest} from '../../worker/self-service/notifications.mjs';

// The review text (review_jobs.payload_ciphertext) is kept for 7 days from the
// fetch; a draft made late in that window outlives it (replies expire 7 days
// after the draft). Such a draft can no longer be delivered.
async function staleDraft(w,store,id,{fetchedAt,erased}){
 await seedDraft(w.ctx,store,id,fetchedAt);
 await w.db.prepare('UPDATE replies SET expires_at=? WHERE job_id=?').bind(fetchedAt+13*D,id).run();
 if(erased)await w.db.prepare('UPDATE review_jobs SET payload_ciphertext=NULL WHERE id=?').bind(id).run();
}
for(const erased of [true,false])test('a draft whose review text is past its 7-day keep ('+(erased?'erased':'not yet erased')+') never holds the notify slot',async t=>{
 const T0=Date.parse('2026-10-06T01:00:00Z'); // JST 10:00
 const w=await world(t,{n:2,T0});const [stale,healthy]=w.stores;
 await staleDraft(w,stale,'old',{fetchedAt:T0-7*D-H,erased});
 await seedDraft(w.ctx,healthy,'fresh',T0-2*H);
 assert.equal((await pickNotifyStore(w.ctx))?.id,healthy.id,'the healthy store is picked');
 await w.runUntil(T0+3*H);
 assert.deepEqual(w.log.pushes.map(p=>p.to),['line-1'],'only the healthy store gets a LINE');
 assert.equal((await w.db.prepare('SELECT count(*) n FROM notification_jobs WHERE store_id=?').bind(stale.id).first()).n,0,'no digest is built for the stale draft');
 assert.equal((await w.db.prepare('SELECT last_error FROM stores WHERE id=?').bind(stale.id).first()).last_error,null);
 assert.equal(await pickNotifyStore(w.ctx),null);
});
test('a digest leaves out a draft past the 7-day keep and still delivers the others',async t=>{
 const T0=Date.parse('2026-10-06T01:00:00Z'); // JST 10:00
 const w=await world(t,{n:1,T0});const [a]=w.stores;
 await staleDraft(w,a,'old',{fetchedAt:T0-7*D-H,erased:false});
 await seedDraft(w.ctx,a,'fresh',T0-2*H);
 await sendSelfDigest(w.ctx,a.id);
 assert.equal(w.log.pushes.length,1);
 const items=(await w.db.prepare('SELECT reply_id FROM notification_items').all()).results.map(r=>r.reply_id);
 assert.deepEqual(items,['ss_fresh']);
 assert.equal((await w.db.prepare('SELECT state FROM notification_jobs').first()).state,'accepted');
});
test('after the LINE quota recovers, a draft whose review text the purge erased does not keep a healthy store from its LINE',async t=>{
 const T0=Date.parse('2026-10-06T00:50:00Z'); // JST 09:50
 const recovered=T0+2*H;                      // JST 11:50
 const w=await world(t,{n:2,T0,quota:()=>w.clock.now<recovered?{type:'limited',value:0}:{type:'limited',value:100000}});
 const [stale,healthy]=w.stores;
 // Fetched 8 days ago and drafted 5 days later while the quota was out: the
 // reply has not expired, but an earlier 7-day purge already erased the text.
 await staleDraft(w,stale,'old',{fetchedAt:T0-8*D,erased:true});
 await seedDraft(w.ctx,healthy,'fresh',T0-2*H);
 await w.runUntil(recovered+2*H);
 assert.deepEqual(w.log.pushes.map(p=>p.to),['line-1'],'the healthy store gets its LINE once the quota is back');
 assert.ok(w.log.pushes[0].at>=recovered&&w.log.pushes[0].at<=recovered+H+5*M,'sent at the first retry after the recovery');
 assert.equal((await w.db.prepare('SELECT count(*) n FROM notification_jobs WHERE store_id=?').bind(stale.id).first()).n,0);
 assert.equal((await w.db.prepare('SELECT last_error FROM stores WHERE id=?').bind(stale.id).first()).last_error,null,'the stale store is never tried');
});
