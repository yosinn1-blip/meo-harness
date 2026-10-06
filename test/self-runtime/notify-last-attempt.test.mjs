import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {H,M,jstDay,iso,world,seedDraft} from '../support/schedule-world.mjs';
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

test('a digest sent at JST 23:55 whose row save failed is closed next morning without using that day',async t=>{
 const night=Date.parse('2026-10-05T14:55:00Z'); // JST 10-05 23:55
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

test('a late cron that sends at JST 23:59:59 and is accepted at 00:00:01 holds the acceptance day even if the row save fails',async t=>{
 const sendAt=Date.parse('2026-10-05T14:59:59Z'); // JST 10-05 23:59:59
 const acceptedAt=sendAt+2000;                     // JST 10-06 00:00:01
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
 await w.runUntil(Date.parse('2026-10-06T14:55:00Z')); // JST 23:55
 const closed=await w.db.prepare("SELECT state,last_attempt_at FROM notification_jobs WHERE day_key='2026-10-05'").first();
 assert.deepEqual([closed.state,closed.last_attempt_at],['accepted',acceptedAt],'the local recovery keeps the acceptance time');
 assert.equal(w.log.pushes.length,1,'no second LINE accepted on JST 10-06: '+JSON.stringify(w.log.pushes.map(p=>iso(p.at))));
 await w.slot(Date.parse('2026-10-07T00:15:00Z')); // JST 10-07 09:15
 assert.deepEqual(w.log.pushes.map(p=>jstDay(p.at)),['2026-10-06','2026-10-07']);
});
