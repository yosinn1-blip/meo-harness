import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {H,M,SLOT,jstDay,jstHour,iso,world,seedDraft} from '../support/schedule-world.mjs';
import {runSelfScheduled} from '../../worker/self-service/scheduled.mjs';
import {meterD1} from '../support/d1-meter.mjs';
import {withD1,applySchema} from '../support/self-runtime.mjs';
import {sendSelfDigest} from '../../worker/self-service/notifications.mjs';
import {sendSelfDigest as legacySendSelfDigest} from '../support/legacy-notifications-4c47ea4.mjs';

test('0006 adds only notification_jobs.last_attempt_at and the test schema applies it',async t=>{
 const sql=await readFile(new URL('../../migrations/0006_notification_last_attempt.sql',import.meta.url),'utf8');
 assert.equal(sql.trim(),'ALTER TABLE notification_jobs ADD COLUMN last_attempt_at INTEGER;');
 const {db}=await withD1(t);
 await applySchema(db,{through:5});
 const before=(await db.prepare('PRAGMA table_info(notification_jobs)').all()).results.map(c=>c.name);
 assert.ok(!before.includes('last_attempt_at'));
 const {db:full}=await withD1(t);await applySchema(full);
 const after=(await full.prepare('PRAGMA table_info(notification_jobs)').all()).results;
 assert.deepEqual(after.map(c=>c.name),[...before,'last_attempt_at']);
 const column=after.at(-1);
 assert.deepEqual([column.type,column.notnull,column.dflt_value],['INTEGER',0,null]);
});

test('a retry of yesterday\'s digest accepted today by the old code still holds today after the switch',async t=>{
 const day1=Date.parse('2026-10-05T11:15:00Z'); // JST 10-05 20:15
 let down=true;
 const w=await world(t,{n:1,T0:day1,lineStatus:()=>down?429:200});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',day1-2*H);
 await assert.rejects(legacySendSelfDigest(w.ctx,a.id),{code:'LINE_RETRY_REQUIRED'}); // old code: 429, retry later
 assert.equal(w.log.pushes.length,0);
 down=false;
 w.clock.now=Date.parse('2026-10-06T01:15:00Z'); // JST 10-06 10:15: the old code retries, LINE accepts
 await legacySendSelfDigest(w.ctx,a.id);
 assert.equal(w.log.pushes.length,1);
 const old=await w.db.prepare('SELECT state,day_key,first_attempt_at,lease_until,last_attempt_at FROM notification_jobs').first();
 assert.deepEqual([old.state,old.day_key,old.first_attempt_at,old.lease_until,old.last_attempt_at],['accepted','2026-10-05',day1,null,null],'the old row has no trace of today');
 // Switch to the new code with a new draft waiting, for the rest of JST 10-06.
 await seedDraft(w.ctx,a,'r2',w.clock.now-2*H);
 w.clock.now+=5*M;
 await w.runUntil(Date.parse('2026-10-06T14:55:00Z')); // JST 23:55
 await sendSelfDigest(w.ctx,a.id);
 assert.equal(w.log.pushes.length,1,'no second LINE on JST 10-06: '+JSON.stringify(w.log.pushes.map(p=>iso(p.at))));
 assert.equal((await w.db.prepare('SELECT count(*) n FROM notification_jobs').first()).n,1);
 await w.slot(Date.parse('2026-10-07T00:15:00Z')); // JST 10-07 09:15
 assert.deepEqual(w.log.pushes.map(p=>jstDay(p.at)),['2026-10-06','2026-10-07'],'the waiting draft goes out the next JST day');
});

test('stores whose LINE push keeps timing out do not starve a healthy store',async t=>{
 const T0=Date.parse('2026-10-06T00:00:00Z'); // JST 09:00
 const calls=new Map();
 const w=await world(t,{n:6,T0,lineStatus:(now,init)=>{
  const to=JSON.parse(init.body).to;calls.set(to,(calls.get(to)??0)+1);
  return to==='line-5'?200:'timeout';
 }});
 // The healthy store's draft is the newest, so it would be picked last.
 for(const [i,s] of w.stores.entries())await seedDraft(w.ctx,s,'d'+i,T0-3*H+i*M);
 await w.runUntil(T0+6*H); // JST 15:00
 const healthy=w.log.pushes.filter(p=>p.to==='line-5');
 assert.equal(healthy.length,1,'the healthy store gets its LINE: '+JSON.stringify(Object.fromEntries(calls)));
 assert.ok(healthy[0].at<=T0+H,'within an hour of JST 09:00: '+iso(healthy[0].at));
 for(let i=0;i<5;i++){
  const n=calls.get('line-'+i)??0;
  assert.ok(n>=3&&n<=13,'line-'+i+' keeps retrying with the 30-minute wait: '+n);
 }
 const held=(await w.db.prepare("SELECT count(*) n FROM notification_jobs WHERE state='pending' AND attempt_no=0").first()).n;
 assert.equal(held,5,'the timing-out digests keep their reservation and retry key');
});

test('a digest sent at JST 20:55, the last notify slot before 21:00, whose row save failed is closed next morning without using that day',async t=>{
 const night=Date.parse('2026-10-05T11:55:00Z'); // JST 10-05 20:55
 let armed=false;
 const w=await world(t,{n:1,T0:night,lineStatus:()=>{armed=true;return 200;}});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',night-2*H);
 // LINE accepts and the push reservation commits; then the acceptance batch fails.
 const meter=meterD1(w.db,sqls=>{if(!armed||!sqls.some(q=>q.includes("state='accepted'")))return false;armed=false;return true;});
 await assert.rejects(sendSelfDigest({...w.ctx,db:meter.db},a.id),/fixture storage unavailable/);
 assert.equal(w.log.pushes.length,1);
 const left=await w.db.prepare('SELECT state,last_attempt_at,lease_until FROM notification_jobs').first();
 assert.deepEqual([left.state,left.last_attempt_at,left.lease_until],['pending',night,null]);
 assert.equal((await w.db.prepare("SELECT state FROM usage_reservations WHERE kind='push'").first()).state,'committed');
 const day2=Date.parse('2026-10-06T00:00:00Z'); // JST 10-06 09:00
 await seedDraft(w.ctx,a,'r2',day2-2*H);
 w.clock.now=day2;
 await w.runUntil(day2+2*H);
 const closed=await w.db.prepare("SELECT state,last_attempt_at FROM notification_jobs WHERE day_key='2026-10-05'").first();
 assert.deepEqual([closed.state,closed.last_attempt_at],['accepted',night],'the local recovery keeps the time of the real send');
 assert.deepEqual(w.log.pushes.map(p=>jstDay(p.at)),['2026-10-05','2026-10-06'],'the next JST day still gets its LINE');
 assert.equal(w.log.line-w.log.quotaGets*2,2,'the local recovery itself calls no LINE API');
});

test('a late cron that starts at JST 20:59:59 and is accepted at 21:00:01 holds that JST day even if the row save fails',async t=>{
 const sendAt=Date.parse('2026-10-05T11:59:59Z'); // JST 10-05 20:59:59, still inside the window
 const acceptedAt=sendAt+2000;                     // JST 10-05 21:00:01
 assert.equal(jstDay(acceptedAt),jstDay(sendAt),'a push started before 21:00 is accepted the same JST day');
 let armed=false;
 const w=await world(t,{n:1,T0:sendAt,lineStatus:now=>{if(now===sendAt){w.clock.now=acceptedAt;armed=true;}return 200;}});const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',sendAt-2*H);
 const meter=meterD1(w.db,sqls=>{if(!armed||!sqls.some(q=>q.includes("state='accepted'")))return false;armed=false;return true;});
 await assert.rejects(sendSelfDigest({...w.ctx,db:meter.db},a.id),/fixture storage unavailable/);
 assert.equal(w.log.pushes.length,1);
 assert.equal((await w.db.prepare("SELECT state FROM usage_reservations WHERE kind='push'").first()).state,'committed');
 const left=await w.db.prepare('SELECT state,last_attempt_at FROM notification_jobs').first();
 assert.deepEqual([left.state,left.last_attempt_at],['pending',acceptedAt],'the acceptance time is saved with the reservation commit');
 const day2=Date.parse('2026-10-06T00:00:00Z'); // JST 10-06 09:00
 await seedDraft(w.ctx,a,'r2',day2-2*H);
 w.clock.now=day2;
 await w.runUntil(Date.parse('2026-10-06T03:00:00Z')); // JST 10-06 12:00
 assert.equal(w.log.pushes.length,2,'r2 went out on JST 10-06');
 await seedDraft(w.ctx,a,'r3',w.clock.now); // fetched after r2's LINE
 await w.runUntil(Date.parse('2026-10-06T14:55:00Z')); // JST 23:55
 const closed=await w.db.prepare("SELECT state,last_attempt_at FROM notification_jobs WHERE day_key='2026-10-05'").first();
 assert.deepEqual([closed.state,closed.last_attempt_at],['accepted',acceptedAt],'the local recovery keeps the acceptance time');
 assert.deepEqual(w.log.pushes.map(p=>jstDay(p.at)),['2026-10-05','2026-10-06'],'one LINE on JST 10-06, no second one: '+JSON.stringify(w.log.pushes.map(p=>iso(p.at))));
 await w.slot(Date.parse('2026-10-07T00:15:00Z')); // JST 10-07 09:15
 assert.deepEqual(w.log.pushes.map(p=>jstDay(p.at)),['2026-10-05','2026-10-06','2026-10-07'],'the draft that came after the 10-06 LINE goes out the next JST day');
});

// Codex review: the first attempt at JST 09:00 fails, a late cron retries at
// JST 23:59:59, LINE accepts at 00:00:01 and the response is lost.
// last_attempt_at would stay on the earlier day, the 24-hour stop would end it
// in the first slot after 09:00 and a new digest would follow, two LINEs on one
// JST day. From JST 21:00 LINE is not
// called at all, so a push started before 21:00 cannot be accepted the next day.
test('a late cron retry at JST 23:59:59 does not call LINE, so a lost acceptance after midnight cannot give two LINEs on one JST day',async t=>{
 const first=Date.parse('2026-10-05T00:00:00Z');  // JST 10-05 09:00
 const lateSlot=Date.parse('2026-10-05T14:55:00Z'); // JST 23:55 notify slot
 const sendAt=Date.parse('2026-10-05T14:59:59Z');   // its late run, JST 23:59:59
 const acceptedAt=sendAt+2000;                      // JST 10-06 00:00:01
 let w;
 w=await world(t,{n:1,T0:first,lineStatus:now=>{
  if(now<sendAt)return 'timeout';
  if(now===sendAt){w.clock.now=acceptedAt;return 'accepted-timeout';} // accepted, response lost
  return 200;
 }});
 const [a]=w.stores;
 await seedDraft(w.ctx,a,'r1',first-2*H);
 await w.runUntil(lateSlot-SLOT); // every LINE call of JST 10-05 times out
 const calls=w.log.pushCalls.length;
 assert.ok(calls>=3,'the digest was retried on JST 10-05: '+calls);
 const lastCall=w.log.pushCalls.at(-1).at;
 assert.ok(jstHour(lastCall)<21,'the last call of JST 10-05 is before 21:00: '+iso(lastCall));
 // The first attempt counts from 09:00 (so the 24-hour stop ends it before any
 // retry the next morning); the retry is due in the 23:55 slot, whose run
 // starts late at 23:59:59.
 await w.db.prepare('UPDATE notification_jobs SET first_attempt_at=?,next_attempt_at=?').bind(first,lateSlot-M).run();
 w.clock.now=sendAt;
 await runSelfScheduled(w.ctx,{scheduledTime:lateSlot});
 await sendSelfDigest(w.ctx,a.id);
 assert.equal(w.log.pushCalls.length,calls,'no LINE call at JST 23:59:59');
 assert.equal(w.log.pushes.length,0);
 const row=await w.db.prepare('SELECT state,last_attempt_at FROM notification_jobs').first();
 assert.deepEqual([row.state,row.last_attempt_at],['pending',lastCall],'last_attempt_at is the real last call');
 // JST 10-06: a new draft is waiting all day.
 await seedDraft(w.ctx,a,'r2',Date.parse('2026-10-05T22:00:00Z')); // JST 10-06 07:00
 w.clock.now=Date.parse('2026-10-05T15:00:00Z');
 await w.runUntil(Date.parse('2026-10-06T14:55:00Z')); // JST 10-06 23:55
 const today=w.log.pushes.filter(p=>jstDay(p.at)==='2026-10-06');
 assert.equal(today.length,1,'one LINE on JST 10-06: '+JSON.stringify(w.log.pushes.map(p=>iso(p.at))));
 for(const p of w.log.pushCalls)assert.ok(jstHour(p.at)>=9&&jstHour(p.at)<21,'LINE is called only from JST 09:00 to 20:59: '+iso(p.at));
 const rows=(await w.db.prepare('SELECT day_key,state FROM notification_jobs ORDER BY day_key').all()).results.map(r=>[r.day_key,r.state]);
 assert.deepEqual(rows,[['2026-10-05','unknown'],['2026-10-06','accepted']],'the ambiguous digest ends at the 24-hour stop without a push; the new draft goes out on JST 10-06');
});
