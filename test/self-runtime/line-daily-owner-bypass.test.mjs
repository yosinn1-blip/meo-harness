import test from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext,readSelfConfig} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode,consumeLineCode,sendLineButton,sendLineCheck,verifyLinePin} from '../../worker/self-service/line-link.mjs';
import {readLineCheckStatus} from '../../worker/self-service/line-check-delivery.mjs';
import {receiveLineButton,confirmLineButton} from '../../worker/self-service/line-button-confirm.mjs';
import {findOwnedStore} from '../../worker/self-service/store-repository.mjs';
import {getSelfStatus,getLineReturnStatus} from '../../worker/self-service/status.mjs';
import {handleSelfRequest} from '../../worker/self-service/router.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
// SHA-256 of the synthetic fixture owner, independently fixed rather than derived by production code.
const OWNER_HASH='2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90';
const enabled={SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:'true',SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:OWNER_HASH};
async function setup(t,{sub='alice',overrides=enabled,automatic=null,consume=true}={}) {
 const {db}=await withD1(t);await applySchema(db);let now=Date.UTC(2026,9,2,7),scenario='ok';const pushes=[],calls=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_MONTHLY_PUSH_LIMIT:'10',SELF_LINE_BUTTON_CONFIRM_ENABLED:'true',
  ...(automatic==='button'?{SELF_LINE_AUTO_BUTTON_ENABLED:'true'}:{}),
  ...(automatic==='pin'?{SELF_LINE_AUTO_PIN_ENABLED:'true'}:{}),...overrides}),{
  now:()=>now,fetchImpl:async(url,init={})=>{
   const u=new URL(url);assert.equal(u.origin,'https://api.line.me');calls.push(u.pathname);
   assert.equal(init.headers.Authorization,'Bearer fixture-line');
   if(u.pathname==='/v2/bot/message/quota')return scenario==='quota-unknown'?new Response(null,{status:500}):Response.json({type:'limited',value:200});
   if(u.pathname==='/v2/bot/message/quota/consumption')return Response.json({totalUsage:scenario==='quota-full'?200:0});
   assert.equal(u.pathname,'/v2/bot/message/push');assert.equal(init.method,'POST');
   assert.match(init.headers['X-Line-Retry-Key'],/^[a-f0-9-]{36}$/);const body=JSON.parse(init.body);
   assert.equal(body.to,'line-fixture');assert.equal(body.messages.length,1);assert(['text','flex'].includes(body.messages[0].type));
   pushes.push(body);return Response.json({});
  }
 });
 await seedStore(ctx,{sub,state:'location_selected',lineUserId:null});const session=await createSession(ctx,sub);
 const actor={sub,sessionHash:session.sessionHash};const {code}=await issueLineCode(ctx,actor);
 const store=()=>findOwnedStore(ctx,sub),event={type:'message',source:{type:'user',userId:'line-fixture'},message:{type:'text',text:code}};
 const consumeCode=()=>consumeLineCode(ctx,event);
 if(consume)await consumeCode();
 const dayBucket='test-day:'+(await store()).id+':'+dateKeys(now).day;
 const fullDay=()=>db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,3,?)').bind(dayBucket,now+86400000).run();
 const dayRow=()=>db.prepare('SELECT * FROM rate_limits WHERE bucket=?').bind(dayBucket).first();
 const snapshot=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
 const status=(hash=actor.sessionHash)=>store().then(s=>readLineCheckStatus(ctx,s,hash));
 const request=path=>new Request('https://meo.test'+path,{headers:{Cookie:session.cookie.split(';')[0]}});
 const post=(path,body={},headers={})=>handleSelfRequest(new Request('https://meo.test/api/self/'+path,{method:'POST',body:JSON.stringify(body),headers:{Origin:'https://meo.test',Cookie:session.cookie.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':session.csrf,...headers}}),ctx.env,ctx);
 return {db,ctx,actor,session,store,pushes,calls,fullDay,dayRow,snapshot,status,request,post,consumeCode,
  advance:n=>now+=n,scenario:s=>scenario=s,
  buttonEvent:()=>({type:'postback',source:{type:'user',userId:'line-fixture'},postback:{data:pushes.at(-1).messages[0].contents.footer.contents[0].action.data}}),
  pin:()=>pushes.at(-1).messages[0].text.match(/確認番号: (\d{6})/)[1]};
}
for(const method of ['button','pin'])test('explicit owner '+method+' permits fourth and fifth sends without altering an existing 3/3 daily row',async t=>{
 const f=await setup(t);await f.fullDay();const row=await f.dayRow(),send=()=>method==='button'?sendLineButton(f.ctx,f.actor):sendLineCheck(f.ctx,f.actor);
 assert.equal((await send()).ok,true);f.advance(60001);assert.equal((await send()).ok,true);
 assert.equal(f.pushes.length,2);assert.deepEqual(await f.dayRow(),row);
 assert.equal((await f.db.prepare("SELECT used FROM usage_budgets WHERE scope='channel' AND kind='push'").first()).used,2);
 assert.equal((await f.db.prepare("SELECT used FROM usage_budgets WHERE scope='channel' AND kind='provider_push'").first()).used,2);
 assert.equal((await f.status()).dailySendLimit,null);
});
test('owner bypass never skips the shared one-minute limit between button and PIN',async t=>{
 const f=await setup(t);await f.fullDay();await sendLineButton(f.ctx,f.actor);const calls=f.calls.length;
 await assert.rejects(()=>sendLineCheck(f.ctx,f.actor),e=>e.code==='RATE_LIMITED'&&e.status===429);
 assert.equal(f.pushes.length,1);assert.equal(f.calls.length,calls);
 assert.deepEqual((await f.status()).sendLimit,{kind:'minute',retryAt:f.ctx.now()+60000});
 f.advance(60000);await sendLineCheck(f.ctx,f.actor);assert.equal(f.pushes.length,2);assert.equal((await f.dayRow()).used,3);
});
test('default, OFF and malformed dedicated settings fail closed at three sends',async t=>{
 const cases=[['unset',{}],['OFF',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:'false'}],
  ['missing owner',{SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:'true'}],['missing flag',{SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:OWNER_HASH}],
  ['boolean flag',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:true}],['uppercase flag',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:'TRUE'}],
  ['empty flag',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:''}],['short hash',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:'abc'}],
  ['uppercase hash',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:OWNER_HASH.toUpperCase()}],
  ['padded hash',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:OWNER_HASH+' '}],
  ['wrong owner hash',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:'0'.repeat(64)}],
  ['hash object',{...enabled,SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:{toString:()=>OWNER_HASH}}]];
 for(const [name,overrides] of cases)await t.test(name,async t=>{
  const f=await setup(t,{overrides});await f.fullDay();const row=await f.dayRow();
  await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');
  assert.equal(f.pushes.length,0);assert.equal(f.calls.length,0);assert.deepEqual(await f.dayRow(),row);
  const status=await f.status();assert.equal(status.sendLimit.kind,'daily');assert.notEqual(status.dailySendLimit,null);
 });
});
test('a different authenticated owner cannot forge a bypass in request JSON, query or headers',async t=>{
 const f=await setup(t,{sub:'bob'});await f.fullDay();const row=await f.dayRow();
 const response=await f.post('line/button?ownerSub=alice',{ownerSub:'alice',sub:'alice',dailySendLimit:null,...enabled},{'X-Owner-Sub':'alice'});
 assert.equal(response.status,429);assert.equal((await response.json()).code,'RATE_LIMITED');
 assert.equal(f.pushes.length,0);assert.deepEqual(await f.dayRow(),row);assert.equal((await f.status()).dailySendLimit,3);
});
test('owner status ignores only daily blocking, is read-only, and OFF restores the unchanged 3/3 row',async t=>{
 const f=await setup(t);await f.fullDay();const before=await f.snapshot();
 for(let i=0;i<3;i++){const status=await f.status();assert.equal(status.dailySendLimit,null);assert.equal(status.retryAfterMs,0);assert.equal(status.sendLimit,null);}
 assert.equal(await f.snapshot(),before);assert.equal(f.calls.length,0);
 await f.db.prepare('INSERT INTO rate_limits VALUES (?,1,?)').bind('test-minute:'+(await f.store()).id,f.ctx.now()+60000).run();
 const limited=await f.snapshot(),owner=await f.status();assert.equal(owner.dailySendLimit,null);assert.equal(owner.retryAfterMs,60000);assert.equal(owner.sendLimit.kind,'minute');
 f.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='false';const off=await f.status();assert.equal(off.dailySendLimit,3);assert.equal(off.sendLimit.kind,'daily');assert(off.retryAfterMs>60000);
 f.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='true';assert.equal((await f.status()).sendLimit.kind,'minute');assert.equal(await f.snapshot(),limited);
 f.advance(60000);assert.equal((await f.status()).retryAfterMs,0);assert.equal((await f.status()).sendLimit,null);
 f.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='false';await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');assert.equal(f.pushes.length,0);
});
test('PIN-only status applies the same owner policy without exposing the button feature',async t=>{
 const f=await setup(t,{overrides:{...enabled,SELF_LINE_BUTTON_CONFIRM_ENABLED:'false'}});await f.fullDay();const before=await f.snapshot();
 const status=await f.status();assert.equal(status.dailySendLimit,null);assert.equal(status.retryAfterMs,0);assert(!('sendLimit' in status));assert.equal(await f.snapshot(),before);
 await sendLineCheck(f.ctx,f.actor);await verifyLinePin(f.ctx,f.actor,f.pin());assert.equal((await f.store()).state,'line_verified');
});
test('monthly local push budget remains enforced when the daily bucket is bypassed',async t=>{
 const f=await setup(t,{overrides:{...enabled,SELF_MONTHLY_PUSH_LIMIT:'1'}});await f.fullDay();await sendLineButton(f.ctx,f.actor);f.advance(60001);
 await assert.rejects(()=>sendLineCheck(f.ctx,f.actor),e=>e.code==='QUOTA_EXHAUSTED');assert.equal(f.pushes.length,1);assert.equal((await f.dayRow()).used,3);
 assert.equal((await f.db.prepare("SELECT used FROM usage_budgets WHERE kind='push'").first()).used,1);
});
for(const scenario of ['quota-full','quota-unknown'])test('provider '+scenario+' still stops a bypassed owner before dispatch',async t=>{
 const f=await setup(t);await f.fullDay();f.scenario(scenario);const row=await f.dayRow();
 await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code===(scenario==='quota-full'?'QUOTA_EXHAUSTED':'QUOTA_UNKNOWN'));
 assert.equal(f.pushes.length,0);assert.deepEqual(await f.dayRow(),row);assert.equal((await f.db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
});
for(const method of ['button','pin'])test('automatic '+method+' delivery shares owner bypass but still requires explicit valid confirmation',async t=>{
 const f=await setup(t,{automatic:method,consume:false});await f.fullDay();const row=await f.dayRow();assert.equal((await f.consumeCode()).ok,true);
 assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].messages[0].type,method==='button'?'flex':'text');assert.deepEqual(await f.dayRow(),row);
 assert.equal((await f.store()).state,'line_pending');assert.equal((await f.store()).termsVersion,null);
 await assert.rejects(()=>f.consumeCode(),e=>e.code==='LINE_CODE_INVALID');assert.equal(f.pushes.length,1);
 if(method==='button'){
  await assert.rejects(()=>confirmLineButton(f.ctx,f.actor,{confirmed:true}));await receiveLineButton(f.ctx,f.buttonEvent());await confirmLineButton(f.ctx,f.actor,{confirmed:true});
 }else{
  await assert.rejects(()=>verifyLinePin(f.ctx,f.actor,'wrong'));await verifyLinePin(f.ctx,f.actor,f.pin());
 }
 assert.equal((await f.store()).state,'line_verified');assert.equal((await f.store()).termsVersion,null);
});
test('owner session, CSRF and original browser remain required despite an exhausted daily bucket',async t=>{
 const f=await setup(t);await f.fullDay();const before=await f.snapshot();
 assert.equal((await f.post('line/button',{}, {'X-CSRF-Token':'wrong'})).status,403);assert.equal(await f.snapshot(),before);
 const other=await createSession(f.ctx,'alice');await assert.rejects(()=>sendLineButton(f.ctx,{sub:'alice',sessionHash:other.sessionHash}),e=>e.code==='LINE_BROWSER_MISMATCH');
 const mismatch=await f.status(other.sessionHash);assert.equal(mismatch.state,'browser_mismatch');assert(!('dailySendLimit' in mismatch));
 await f.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').bind(f.ctx.now(),f.actor.sessionHash).run();
 await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='STORE_CHANGED');assert.equal(f.pushes.length,0);
});
test('public projections never expose the dedicated flag, owner hash or owner identity, and status reads never dispatch',async t=>{
 const f=await setup(t);await f.fullDay();const before=await f.snapshot();
 const outputs=[readSelfConfig(f.ctx.env),await getSelfStatus(f.ctx,f.request('/api/self/status')),
  await getLineReturnStatus(f.ctx,f.request('/api/self/line/return-status')),
  await getSelfStatus(f.ctx,new Request('https://meo.test/api/self/status'))];
 for(const output of outputs){const text=JSON.stringify(output);assert(!text.includes(OWNER_HASH));assert(!text.includes('alice'));assert(!text.includes('SELF_LINE_CHECK_DAILY_BYPASS'));assert(!text.includes('line-fixture'));}
 assert.equal(outputs[1].lineCheck.dailySendLimit,null);assert.equal(outputs[2].lineCheck.dailySendLimit,null);
 assert(!('dailySendLimit' in outputs[3]));assert.equal(await f.snapshot(),before);assert.equal(f.calls.length,0);
 assert.equal(readSelfConfig(f.ctx.env).registrationEnabled,true);assert.equal(readSelfConfig(f.ctx.env).processingEnabled,true);
});
