import test from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode,consumeLineCode,sendLineButton,sendLineCheck,verifyLinePin} from '../../worker/self-service/line-link.mjs';
import {readLineCheckStatus} from '../../worker/self-service/line-check-delivery.mjs';
import {receiveLineButton,confirmLineButton} from '../../worker/self-service/line-button-confirm.mjs';
import {findOwnedStore} from '../../worker/self-service/store-repository.mjs';
import {getLineReturnStatus} from '../../worker/self-service/status.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
async function setup(t,{at=Date.UTC(2026,9,2,7),button=true}={}){
 const {db}=await withD1(t);await applySchema(db);let now=at;const pushes=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_LINE_BUTTON_CONFIRM_ENABLED:String(button),SELF_MONTHLY_PUSH_LIMIT:'10'}),{now:()=>now,fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).origin,'https://api.line.me');
  if(url.endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(url.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert(url.endsWith('/push'));pushes.push(JSON.parse(init.body));return Response.json({});
 }});
 await seedStore(ctx,{state:'location_selected',lineUserId:null});const session=await createSession(ctx,'alice'),other=await createSession(ctx,'alice');
 const actor={sub:'alice',sessionHash:session.sessionHash};const {code}=await issueLineCode(ctx,actor);
 await consumeLineCode(ctx,{type:'message',source:{type:'user',userId:'line-a'},message:{type:'text',text:code}});
 if(button)await sendLineButton(ctx,actor);else await sendLineCheck(ctx,actor);
 const store=()=>findOwnedStore(ctx,'alice'),status=async(hash=actor.sessionHash)=>readLineCheckStatus(ctx,await store(),hash);
 const fullDay=async(expiry=now+86400000)=>db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,3,?)').bind('test-day:'+(await store()).id+':'+dateKeys(now).day,expiry).run();
 const snapshot=async()=>{const ts=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(ts.map(async t=>[t.name,(await db.prepare('SELECT * FROM "'+t.name+'"').all()).results])));};
 return {db,ctx,actor,session,other,pushes,status,store,fullDay,snapshot,advance:n=>now+=n,event:()=>({type:'postback',source:{type:'user',userId:'line-a'},postback:{data:pushes.at(-1).messages[0].contents.footer.contents[0].action.data}})};
}
test('daily cap and expiry are read-only projections; receipt/owner confirmation still work on a live card',async t=>{
 const f=await setup(t);await f.fullDay();const before=await f.snapshot();
 const status=await f.status();assert.equal(status.sendLimit.kind,'daily');assert.equal(status.buttonAvailable,false);assert.equal(await f.snapshot(),before);
 await receiveLineButton(f.ctx,f.event());assert.equal((await f.status()).buttonAvailable,true);await confirmLineButton(f.ctx,f.actor,{confirmed:true});
 assert.equal((await f.store()).state,'line_verified');assert.equal((await f.store()).termsVersion,null);assert.equal(f.pushes.length,1);
});
test('expired 3/3 status stays blocked after link retention; wrong return remains generic without CSRF or limits',async t=>{
 const f=await setup(t);await f.fullDay();f.advance(300001);const before=await f.snapshot();
 assert.equal((await f.status()).buttonExpired,true);assert.equal((await f.status()).sendLimit.kind,'daily');assert.equal(await f.snapshot(),before);
 await assert.rejects(()=>receiveLineButton(f.ctx,f.event()),e=>e.code==='LINE_CONFIRMATION_INVALID');
 await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');assert.equal(f.pushes.length,1);
 f.advance(600001);await purgeExpired(f.ctx);const retained=await f.snapshot();
 const status=await f.status();assert.equal(status.state,'link_missing');assert.equal(status.sendLimit.kind,'daily');assert.equal(await f.snapshot(),retained);
 const returned=await getLineReturnStatus(f.ctx,new Request('https://meo.test/api/self/line/return-status',{headers:{Cookie:f.other.cookie.split(';')[0]}}));
 assert.deepEqual(returned,{ok:true,state:'line_return_mismatch',csrf:null});assert.equal(await f.snapshot(),retained);
});
for(const button of [true,false])test('JST midnight changes the daily bucket without resetting usage, mode '+button,async t=>{
 const at=Date.UTC(2026,9,2,14,59,58),f=await setup(t,{at,button});await f.fullDay();const before=await f.snapshot();
 const status=await f.status();assert.equal(status.retryAfterMs,60000);
 if(button)assert.deepEqual(status.sendLimit,{kind:'daily',retryAt:Date.UTC(2026,9,2,15)});else assert(!('sendLimit' in status));
 f.advance(2000);const after=await f.status();assert.equal(after.retryAfterMs,58000);if(button)assert.equal(after.sendLimit.kind,'minute');
 f.advance(58000);assert.equal((await f.status()).retryAfterMs,0);if(button)assert.equal((await f.status()).sendLimit,null);
 assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,1);
});
test('daily row that expires before midnight unlocks only when the existing row actually expires',async t=>{
 const f=await setup(t);f.advance(60000);await f.fullDay(f.ctx.now()+5000);const before=await f.snapshot();
 assert.equal((await f.status()).retryAfterMs,5000);assert.equal((await f.status()).sendLimit.kind,'daily');f.advance(5000);
 assert.equal((await f.status()).sendLimit,null);assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,1);
});
test('explicit PIN fallback shares daily blocking while PIN verification is independent of sending',async t=>{
 const f=await setup(t);f.advance(60001);await sendLineCheck(f.ctx,f.actor);await f.fullDay();
 const status=await f.status();assert.equal(status.method,'pin');assert.equal(status.pinAvailable,true);assert.equal(status.sendLimit.kind,'daily');
 const pin=f.pushes[1].messages[0].text.match(/確認番号: (\d{6})/)[1];
 await verifyLinePin(f.ctx,f.actor,pin);assert.equal((await f.store()).state,'line_verified');assert.equal((await f.store()).termsVersion,null);assert.equal(f.pushes.length,2);
});
