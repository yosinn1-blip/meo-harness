import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withD1,applySchema,fixtureEnv,seedStore } from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import { issueLineCode,consumeLineCode,sendLineCheck,sendLineButton,verifyLinePin } from "../../worker/self-service/line-link.mjs";
import { receiveLineButton,confirmLineButton } from "../../worker/self-service/line-button-confirm.mjs";
import { readLineCheckStatus } from "../../worker/self-service/line-check-delivery.mjs";
import { findOwnedStore } from "../../worker/self-service/store-repository.mjs";
import { disconnectStore,activateStore } from "../../worker/self-service/lifecycle.mjs";
import { purgeExpired } from "../../worker/self-service/retention.mjs";
import { createSession } from "../../worker/self-service/session.mjs";
import { getLineReturnStatus } from "../../worker/self-service/status.mjs";
const actor={sub:"alice",sessionHash:"fixture-original-browser"};
async function setup(t,overrides={},schema={}) {
  const {db}=await withD1(t);await applySchema(db,schema);
  let now=100000;const pushes=[];let scenario="ok",quotaHook=null,pushHook=null;
  const ctx=createSelfContext(fixtureEnv(db,{SELF_LINE_BUTTON_CONFIRM_ENABLED:"true",...overrides}),{
    now:()=>now,fetchImpl:async(url,init={})=>{
      assert.equal(new URL(url).origin,"https://api.line.me");
      if(url.endsWith('/quota')) {if(quotaHook){const h=quotaHook;quotaHook=null;await h();}return scenario==='quota-unknown'?new Response(null,{status:500}):Response.json({type:'limited',value:200});}
      if(url.endsWith('/consumption'))return Response.json({totalUsage:scenario==='quota-full'?200:0});
      assert(url.endsWith('/push'));pushes.push(JSON.parse(init.body));if(pushHook){const h=pushHook;pushHook=null;await h();}
      if(scenario==='unknown')throw Error('fixture ambiguous dispatch');
      if(scenario==='failed')return new Response(null,{status:400});
      return Response.json({});
    },
  });
  const store=await seedStore(ctx,{state:'location_selected',lineUserId:null});
  await db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,NULL)").bind(actor.sessionHash,actor.sub,"fixture-csrf",now+86400000,now).run();
  const code=await issueLineCode(ctx,actor);
  await consumeLineCode(ctx,{type:'message',source:{type:'user',userId:'line-a'},message:{type:'text',text:code.code}});
  return {db,ctx,store,pushes,advance:n=>now+=n,scenario:s=>scenario=s,onQuota:fn=>quotaHook=fn,onPush:fn=>pushHook=fn,
    event:(overrides={})=>({type:'postback',source:{type:'user',userId:'line-a'},postback:{data:pushes.at(-1).messages[0].contents.footer.contents[0].action.data},...overrides}),
    pin:()=>pushes.at(-1).messages[0].text.match(/確認番号: (\d{6})/)[1],
    status:async()=>readLineCheckStatus(ctx,await findOwnedStore(ctx,actor.sub),actor.sessionHash)};
}
const rows=async db=>JSON.stringify((await db.prepare("SELECT * FROM line_button_checks").all()).results);
for (const buttonConfirm of [true,false]) test('missing link is distinct from another browser; status stays read-only, button mode '+buttonConfirm,async t=>{
  const f=await setup(t,{SELF_LINE_BUTTON_CONFIRM_ENABLED:String(buttonConfirm)},buttonConfirm?{}:{through:4});
  const store=await findOwnedStore(f.ctx,actor.sub);
  const different=await readLineCheckStatus(f.ctx,store,'fixture-other-browser');
  assert.equal(different.state,'browser_mismatch');assert.equal(different.code,'LINE_BROWSER_MISMATCH');
  f.advance(900001);await purgeExpired(f.ctx);
  const before=JSON.stringify(await findOwnedStore(f.ctx,actor.sub));
  const state=await f.status();
  assert.deepEqual(state,{state:'link_missing',code:'LINE_LINK_MISSING',pinAvailable:false,expiresAt:null,retryAfterMs:0,...(buttonConfirm?{sendLimit:null}:{})});
  assert.equal(JSON.stringify(await findOwnedStore(f.ctx,actor.sub)),before);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM line_links').first()).n,0);
  await assert.rejects(()=>sendLineCheck(f.ctx,actor),e=>e.code==='LINE_BROWSER_MISMATCH');
  if(buttonConfirm)await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='LINE_BROWSER_MISMATCH');
  assert.equal(f.pushes.length,0);
  const code=await issueLineCode(f.ctx,actor);
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).pendingLineUserId,null);
  await consumeLineCode(f.ctx,{type:'message',source:{type:'user',userId:'line-a'},message:{type:'text',text:code.code}});
  assert.equal((await f.status()).state,'idle');assert.equal(f.pushes.length,0);
});
test('button sends one Flex, no PIN/token leakage, receipt only, then original owner explicitly confirms',async t=>{
  const f=await setup(t);assert.equal(f.pushes.length,0);await sendLineButton(f.ctx,actor);
  assert.equal(f.pushes.length,1);const msg=f.pushes[0].messages[0];assert.equal(msg.type,'flex');
  assert.equal(msg.contents.footer.contents[1].action.uri,'https://meo.test/start?openExternalBrowser=1');
  const nonce=f.event().postback.data.split(':').at(-1);assert.match(nonce,/^[\w-]{43}$/);
  assert(!(await rows(f.db)).includes(nonce));assert.equal((await f.db.prepare('SELECT count(*) n FROM line_checks').first()).n,0);
  let status=await f.status();assert.equal(status.method,'button');assert.equal(status.pinAvailable,false);assert.equal(status.buttonAvailable,false);
  assert(!JSON.stringify(status).includes('line-a'));assert(!JSON.stringify(status).includes(nonce));
  await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}));
  await receiveLineButton(f.ctx,f.event());assert.equal((await f.status()).buttonAvailable,true);
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_pending');
  await assert.rejects(()=>activateStore(f.ctx,actor,{confirmed:false,termsVersion:'fixture-v1'}),e=>e.code==='ACTIVATION_NOT_READY');
  await assert.rejects(()=>activateStore(f.ctx,actor,{confirmed:true,termsVersion:'fixture-v1'}),e=>e.code==='LINE_VERIFICATION_REQUIRED');
  await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:false}));
  await confirmLineButton(f.ctx,actor,{confirmed:true});
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');assert.equal((await findOwnedStore(f.ctx,actor.sub)).termsVersion,null);
  await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}));
  await assert.rejects(()=>receiveLineButton(f.ctx,f.event()));assert.equal(f.pushes.length,1);
});
test('duplicate concurrent postbacks and owner double-click each consume once',async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);const e=f.event();
  const received=await Promise.all([receiveLineButton(f.ctx,e),receiveLineButton(f.ctx,e)]);
  assert.equal(received.filter(r=>!r.duplicate).length,1);
  const out=await Promise.allSettled([confirmLineButton(f.ctx,actor,{confirmed:true}),confirmLineButton(f.ctx,actor,{confirmed:true})]);
  assert.equal(out.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.pushes.length,1);
});
for(const [name,change] of [['another LINE',{source:{type:'user',userId:'line-b'}}],['group',{source:{type:'group',userId:'line-a'}}],['room',{source:{type:'room',userId:'line-a'}}],['another purpose',{postback:{data:'approve:ss_fake'}}],['malformed nonce',{postback:{data:'meo-confirm:v1:short'}}]])
  test('reject '+name+' without changing challenge',async t=>{const f=await setup(t);await sendLineButton(f.ctx,actor);const before=await rows(f.db);await assert.rejects(()=>receiveLineButton(f.ctx,f.event(change)));assert.equal(await rows(f.db),before);});
for(const [name,alter] of [
  ['expiry',f=>f.advance(300000)],['session revoke',f=>f.db.prepare('DELETE FROM sessions').run()],
  ['session expiry',f=>f.db.prepare('UPDATE sessions SET expires_at=0').run()],
  ['session owner changed',f=>f.db.prepare("UPDATE sessions SET owner_sub='bob'").run()],
  ['generation changed',f=>f.db.prepare('UPDATE stores SET generation=generation+1').run()],
  ['LINE changed',f=>f.db.prepare("UPDATE stores SET pending_line_user_id='line-b'").run()],
  ['attempt changed',f=>f.db.prepare("UPDATE line_check_deliveries SET attempt_id='fixture-replaced'").run()],
  ['delivery held',f=>f.db.prepare("UPDATE line_check_deliveries SET state='held'").run()],
  ['delivery failed',f=>f.db.prepare("UPDATE line_check_deliveries SET state='failed'").run()],
  ['disabled',f=>{f.ctx.env.SELF_LINE_BUTTON_CONFIRM_ENABLED='false';}],
  ['both flags ON',f=>{f.ctx.env.SELF_LINE_AUTO_PIN_ENABLED='true';}],
]) test('receipt and final confirm reject after '+name,async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);const event=f.event();await receiveLineButton(f.ctx,event);await alter(f);
  const before=await rows(f.db);await assert.rejects(()=>receiveLineButton(f.ctx,event));await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}));assert.equal(await rows(f.db),before);
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_pending');
});
test('same owner different session or other owner cannot send/confirm and return is generic',async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);await receiveLineButton(f.ctx,f.event());
  const other=await createSession(f.ctx,actor.sub),bob=await createSession(f.ctx,'bob');
  for(const a of [{sub:'alice',sessionHash:other.sessionHash},{sub:'bob',sessionHash:bob.sessionHash}]){
    await assert.rejects(()=>sendLineButton(f.ctx,a));await assert.rejects(()=>confirmLineButton(f.ctx,a,{confirmed:true}));
  }
  for(const cookie of [undefined,other.cookie.split(';')[0],bob.cookie.split(';')[0]]){
    const state=await getLineReturnStatus(f.ctx,new Request('https://meo.test/api/self/line/return-status',{headers:cookie?{Cookie:cookie}:{}}));
    assert.deepEqual(state,{ok:true,state:'line_return_mismatch',csrf:null});
  }
});
test('PIN fallback invalidates old button/receipt; switching back deletes PIN atomically',async t=>{
  const f=await setup(t,{SELF_MONTHLY_PUSH_LIMIT:'10'});await sendLineButton(f.ctx,actor);const old=f.event();await receiveLineButton(f.ctx,old);
  f.advance(60001);await sendLineCheck(f.ctx,actor);const pin=f.pin();assert.equal((await f.status()).method,'pin');
  await assert.rejects(()=>receiveLineButton(f.ctx,old));await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}));
  f.advance(60001);await sendLineButton(f.ctx,actor);assert.equal((await f.status()).method,'button');
  await assert.rejects(()=>verifyLinePin(f.ctx,actor,pin));assert.equal((await f.db.prepare('SELECT count(*) n FROM line_checks').first()).n,0);
  await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});assert.equal(f.pushes.length,3);
});
test('PIN fallback can finish with button feature OFF; OFF and missing migration keep PIN operational',async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);f.ctx.env.SELF_LINE_BUTTON_CONFIRM_ENABLED='false';f.advance(60001);
  await sendLineCheck(f.ctx,actor);await verifyLinePin(f.ctx,actor,f.pin());assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');
  const legacy=await setup(t,{SELF_LINE_BUTTON_CONFIRM_ENABLED:'false'},{through:4});
  await assert.rejects(()=>sendLineButton(legacy.ctx,actor),e=>e.code==='LINE_BUTTON_DISABLED');
  await sendLineCheck(legacy.ctx,actor);assert.equal((await legacy.status()).pinAvailable,true);await verifyLinePin(legacy.ctx,actor,legacy.pin());
});
test('quota/rate/day holds dispatch no extra messages; unknown keeps reservations and accepts actual receipt',async t=>{
  const f=await setup(t,{SELF_MONTHLY_PUSH_LIMIT:'10'});f.scenario('unknown');await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='LINE_RESULT_UNKNOWN');
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='uncertain'").first()).n,2);
  const before=await rows(f.db);for(let i=0;i<8;i++)await f.status();assert.equal(await rows(f.db),before);assert.equal(f.pushes.length,1);
  await receiveLineButton(f.ctx,f.event());assert.equal((await f.status()).buttonAvailable,true);
  f.scenario('ok');await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='RATE_LIMITED');assert.equal(f.pushes.length,1);
  for(let i=0;i<2;i++){f.advance(60001);await sendLineButton(f.ctx,actor);}f.advance(60001);
  await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='RATE_LIMITED');assert.equal(f.pushes.length,3);
});
for(const scenario of ['quota-full','quota-unknown','failed'])test('provider '+scenario+' cannot confirm and releases only known unused capacity',async t=>{
  const f=await setup(t);f.scenario(scenario);await assert.rejects(()=>sendLineButton(f.ctx,actor));assert.equal((await f.status()).buttonAvailable,false);
  assert.equal((await f.status()).method,'button');assert.equal((await f.status()).expiresAt,null);
  assert.equal(f.pushes.length,scenario==='failed'?1:0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state<>'released'").first()).n,0);
  if(f.pushes.length)await assert.rejects(()=>receiveLineButton(f.ctx,f.event()));
});
for(const operation of ['reissue','disconnect','logout','flag-off','expiry'])test(operation+' before dispatch prevents send and releases reservation',async t=>{
  const f=await setup(t);f.onQuota(async()=>{
    if(operation==='reissue')await issueLineCode(f.ctx,actor);
    if(operation==='disconnect')await disconnectStore(f.ctx,actor);
    if(operation==='logout')await f.db.prepare('DELETE FROM sessions').run();
    if(operation==='flag-off')f.ctx.env.SELF_LINE_BUTTON_CONFIRM_ENABLED='false';
    if(operation==='expiry')f.advance(300001);
  });await assert.rejects(()=>sendLineButton(f.ctx,actor));assert.equal(f.pushes.length,0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state<>'released'").first()).n,0);
});
test('concurrent button/PIN send cannot steal an in-flight claim or double dispatch',async t=>{
  const f=await setup(t);let release,entered;const blocked=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
  f.onQuota(async()=>{entered();await blocked;});const first=sendLineButton(f.ctx,actor);await seen;
  await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='LINE_CHECK_BUSY');await assert.rejects(()=>sendLineCheck(f.ctx,actor),e=>e.code==='LINE_CHECK_BUSY');
  release();await first;assert.equal(f.pushes.length,1);
});
test('receipt can arrive during sending; late finish does not erase receipt or confirmed destination',async t=>{
  const f=await setup(t);f.onPush(async()=>{await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});});
  await sendLineButton(f.ctx,actor);assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');
  const record=await f.db.prepare('SELECT received_at,consumed_at FROM line_button_checks').first();assert(record.received_at);assert(record.consumed_at);assert.equal(f.pushes.length,1);
});
test('late dispatch after lease takeover cannot erase the newer attempt or use its old token',async t=>{
  const f=await setup(t,{SELF_MONTHLY_PUSH_LIMIT:'10'});let old;
  f.onPush(async()=>{old=f.event();f.advance(90001);await sendLineButton(f.ctx,actor);});
  await sendLineButton(f.ctx,actor);assert.equal(f.pushes.length,2);await assert.rejects(()=>receiveLineButton(f.ctx,old));
  await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='committed'").first()).n,4);
});
test('code reissue/logout/disconnect cascade challenges; expired cleanup retains budgets',async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);const event=f.event();await issueLineCode(f.ctx,actor);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);await assert.rejects(()=>receiveLineButton(f.ctx,event));
  const g=await setup(t);await sendLineButton(g.ctx,actor);g.advance(300001);await purgeExpired(g.ctx);
  assert.equal((await g.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,1);
  assert.equal((await g.status()).method,'button');assert.equal((await g.status()).expiresAt,null);assert.equal((await g.status()).buttonAvailable,false);
  g.advance(600001);await purgeExpired(g.ctx);
  assert.equal((await g.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);
  assert.equal((await g.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='committed'").first()).n,2);
});
test('a card issued near consumed-code expiry keeps its full five-minute confirmation window',async t=>{
  const f=await setup(t);f.advance(899001);await sendLineButton(f.ctx,actor);f.advance(2001);await purgeExpired(f.ctx);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,1);
  await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');
});
test('final D1 batch rejects a generation change after its initial read without rolling back new state',async t=>{
  const f=await setup(t);await sendLineButton(f.ctx,actor);await receiveLineButton(f.ctx,f.event());
  const real=f.ctx.db;let injected=false;f.ctx.db={prepare:sql=>real.prepare(sql),batch:async statements=>{
    if(!injected){injected=true;await real.prepare('UPDATE stores SET generation=generation+1').run();}
    return real.batch(statements);
  }};
  await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}),e=>e.code==='LINE_CONFIRMATION_INVALID');
  assert.equal((await real.prepare('SELECT state FROM stores').first()).state,'line_pending');
  assert.equal((await real.prepare('SELECT consumed_at FROM line_button_checks').first()).consumed_at,null);
});
test('0005 adds only an empty challenge table and keeps existing schema, rows, and OFF PIN usable',async t=>{
  const f=await setup(t,{SELF_LINE_BUTTON_CONFIRM_ENABLED:'false'},{through:4});await sendLineCheck(f.ctx,actor);const pin=f.pin();
  const schemaSql="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY type,name";
  const before=(await f.db.prepare(schemaSql).all()).results;
  const tables=before.filter(r=>r.type==='table').map(r=>r.name);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await f.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()).results])));
  const rowsBefore=await snapshot();
  const migration=await readFile(new URL('../../migrations/0005_line_button_check.sql',import.meta.url),'utf8');
  await f.db.prepare(migration).run();
  const after=(await f.db.prepare(schemaSql).all()).results;
  assert.deepEqual(after.filter(r=>before.some(old=>old.name===r.name)),before);
  assert.deepEqual(await snapshot(),rowsBefore);
  const added=after.filter(r=>!before.some(old=>old.name===r.name));
  assert.equal(added.length,1);assert.equal(added[0].name,'line_button_checks');assert.equal(added[0].type,'table');
  assert.equal((await f.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);
  assert.equal((await f.status()).pinAvailable,true);await verifyLinePin(f.ctx,actor,pin);
  assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');
});
