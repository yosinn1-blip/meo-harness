// Throughput simulations: the real scheduler, real D1 (miniflare), 5-minute
// slots for 72 hours. Slow (each D1 call costs ~7 ms through miniflare).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {H,M,SLOT,jstDay,iso,world,seedDraft,tenReviews,deliveryInvariants} from '../support/schedule-world.mjs';

for(const [label,T0,limitH] of [['morning JST 08:05',Date.parse('2026-10-05T23:05:00Z'),9],['night JST 21:05',Date.parse('2026-10-06T12:05:00Z'),13.5]])
test('10 stores starting together at '+label+' each get a first LINE within '+limitH+'h',async t=>{
 const w=await world(t,{n:10,T0,reviewsFor:tenReviews(T0)});
 await w.runUntil(T0+72*H);
 const first=w.stores.map((s,i)=>{const p=w.log.pushes.find(x=>x.to==='line-'+i);return p?(p.at-T0)/H:Infinity;});
 t.diagnostic('first LINE hours '+first.map(x=>x.toFixed(2)).join(','));
 const counts=(await w.db.prepare('SELECT j.store_id,j.id,count(*) c,j.first_attempt_at a FROM notification_jobs j JOIN notification_items i ON i.notification_id=j.id GROUP BY j.id ORDER BY j.first_attempt_at').all()).results;
 const firstCounts=w.stores.map(s=>counts.find(c=>c.store_id===s.id)?.c);
 t.diagnostic('first LINE items '+firstCounts.join(','));
 const all=w.stores.map(s=>{const rows=counts.filter(c=>c.store_id===s.id);return rows.reduce((a,c)=>a+c.c,0)===10?(rows.at(-1).a-T0)/H:Infinity;});
 t.diagnostic('all 10 delivered hours max '+Math.max(...all).toFixed(2));
 t.diagnostic('worst per role '+JSON.stringify(w.worst));
 t.diagnostic('external calls in 72h '+JSON.stringify({groq:w.log.groq,google:w.log.google,googleList:w.log.googleList.length,line:w.log.line,pushes:w.log.pushes.length}));
 for(const h of first)assert.ok(h<=limitH,'first LINE hours '+first.join(','));
 await deliveryInvariants(w);
 assert.equal((await w.db.prepare('SELECT count(*) n FROM notification_items').first()).n,100,'every review is delivered within 72h');
 assert.ok(w.log.googleList.every(x=>x.size===20));
});

for(const n of [8,10])test(n+' stores in steady state get a LINE every day they have a deliverable draft',async t=>{
 const T0=Date.parse('2026-10-01T15:00:00Z'); // JST 10/02 00:00
 let seed=7+n;const rng=()=>(seed=(seed*1103515245+12345)%2**31)/2**31;
 const arrivals=Array.from({length:n},()=>Array.from({length:3},(_,d)=>T0+d*24*H+Math.floor(rng()*24*H)));
 const w=await world(t,{n,T0,reviewsFor:(loc)=>arrivals[loc-1].map((a,d)=>({reviewId:'d'+d,starRating:'FIVE',comment:'良かったです'+d,createTime:iso(a),updateTime:iso(a)}))});
 await w.runUntil(T0+72*H);
 const jobs=(await w.db.prepare('SELECT j.store_id,j.created_at,nj.first_attempt_at sent FROM review_jobs j LEFT JOIN replies r ON r.job_id=j.id LEFT JOIN notification_items i ON i.reply_id=r.id LEFT JOIN notification_jobs nj ON nj.id=i.notification_id').all()).results;
 assert.ok(jobs.length>=2*n&&jobs.length<=3*n,'reviews of the last day may still be waiting for their poll');
 let had=0,missed=0;
 for(let d=0;d<3;d++){
  const dayStart=T0+d*24*H,day=jstDay(dayStart);
  for(const [i,s] of w.stores.entries()){
   if(!jobs.some(j=>j.store_id===s.id&&j.created_at+H<=dayStart+20*H&&(j.sent===null||j.sent>=dayStart)))continue;
   had++;if(!w.log.pushes.some(p=>p.to==='line-'+i&&jstDay(p.at)===day))missed++;
  }
 }
 t.diagnostic(JSON.stringify({had,missed,pushes:w.log.pushes.length,worst:w.worst}));
 t.diagnostic('external calls in 72h '+JSON.stringify({groq:w.log.groq,google:w.log.google,googleList:w.log.googleList.length,line:w.log.line,quotaGets:w.log.quotaGets}));
 assert.ok(had>=n,'the scenario has deliverable store-days');assert.equal(missed,0);
 await deliveryInvariants(w);
});
