import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext,readSelfConfig} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode,consumeLineCode,sendLineButton,sendLineCheck,verifyLinePin} from '../../worker/self-service/line-link.mjs';
import {readLineCheckStatus} from '../../worker/self-service/line-check-delivery.mjs';
import {receiveLineButton,confirmLineButton} from '../../worker/self-service/line-button-confirm.mjs';
import {findOwnedStore} from '../../worker/self-service/store-repository.mjs';
import {getSelfStatus,getLineReturnStatus} from '../../worker/self-service/status.mjs';
import {handleSelfRequest} from '../../worker/self-service/router.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
// Raw Node cannot import .md/.txt view sources. Bundle in memory exactly as the
// existing worker build does, without writing the shared E2E worker artifact.
let compiledRouterPromise;
function compiledRouter(){
 return compiledRouterPromise??=build({entryPoints:['worker/self-service/router.mjs'],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,
  loader:{'.html':'text','.css':'text','.txt':'text','.md':'text'}})
  .then(result=>import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')))
  .then(module=>module.handleSelfRequest);
}
const enabled={SELF_LINE_BUTTON_CONFIRM_ENABLED:'true',SELF_LINE_ONE_BUTTON_ENABLED:'true'};
const ownerBypass={SELF_LINE_CHECK_DAILY_BYPASS_ENABLED:'true',SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256:'2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90'};
async function setup(t,{overrides={},consume=true,sub='alice'}={}){
 const {db}=await withD1(t);await applySchema(db);let now=Date.UTC(2026,9,2,7),scenario='ok',quotaHook=null;const pushes=[],calls=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_MONTHLY_PUSH_LIMIT:'10',...enabled,...overrides}),{now:()=>now,fetchImpl:async(url,init={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.line.me');assert.equal(init.headers.Authorization,'Bearer fixture-line');calls.push(u.pathname);
  if(u.pathname==='/v2/bot/message/quota'){if(quotaHook){const hook=quotaHook;quotaHook=null;await hook();}return scenario==='quota-unknown'?new Response(null,{status:500}):Response.json({type:'limited',value:200});}
  if(u.pathname==='/v2/bot/message/quota/consumption')return Response.json({totalUsage:scenario==='quota-full'?200:0});
  assert.equal(u.pathname,'/v2/bot/message/push');assert.equal(init.method,'POST');assert.match(init.headers['X-Line-Retry-Key'],/^[a-f0-9-]{36}$/);
  const body=JSON.parse(init.body);assert.equal(body.to,'line-fixture');assert.equal(body.messages.length,1);pushes.push(body);
  if(scenario==='unknown')throw Error('fixture uncertain LINE result');if(scenario==='failed')return new Response(null,{status:400});return Response.json({});
 }});
 await seedStore(ctx,{sub,state:'location_selected',lineUserId:null});const session=await createSession(ctx,sub),actor={sub,sessionHash:session.sessionHash};
 const {code}=await issueLineCode(ctx,actor),event={type:'message',source:{type:'user',userId:'line-fixture'},message:{type:'text',text:code}};
 const consumeCode=(options={})=>consumeLineCode(ctx,event,options);if(consume)await consumeCode();const store=()=>findOwnedStore(ctx,sub);
 const status=()=>store().then(s=>readLineCheckStatus(ctx,s,actor.sessionHash));
 const request=(path='/api/self/line/return-status',s=session)=>new Request('https://meo.test'+path,{headers:{Cookie:s.cookie.split(';')[0]}});
 const post=(path,body={},s=session,headers={})=>handleSelfRequest(new Request('https://meo.test/api/self/'+path,{method:'POST',body:JSON.stringify(body),headers:{Origin:'https://meo.test',Cookie:s.cookie.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':s.csrf,...headers}}),ctx.env,ctx);
 const snapshot=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
 const dayBucket='test-day:'+(await store()).id+':'+dateKeys(now).day;
 return {db,ctx,session,actor,pushes,calls,store,status,request,post,snapshot,consumeCode,dayBucket,advance:n=>now+=n,scenario:s=>scenario=s,onQuota:hook=>quotaHook=hook,
  oldEvent:()=>({type:'postback',source:{type:'user',userId:'line-fixture'},postback:{data:pushes.at(-1).messages[0].contents.footer.contents[0].action.data}})};
}
function card(f,index=-1){
 const message=f.pushes.at(index).messages[0];assert.equal(message.type,'flex');const actions=message.contents.footer.contents.filter(x=>x.action).map(x=>x.action);
 assert.equal(actions.length,1,'one-button mode must have exactly one actionable control');assert.equal(actions[0].type,'uri');
 assert.equal(actions[0].label,'確認して登録画面へ進む');const url=new URL(actions[0].uri),params=new URLSearchParams(url.hash.slice(1)),pin=params.get('line-confirm');
 assert.match(pin,/^\d{6}$/);return {message,action:actions[0],url,params,pin,expiresAt:Number(params.get('expires')),storeId:params.get('store')};
}
test('one-button flag is strict, depends on effective button mode, and never reinterprets legacy autoPIN',()=>{
 const env=fixtureEnv({},enabled);assert.equal(readSelfConfig(env).lineOneButton,true);
 for(const v of [undefined,'false','','TRUE',true])assert.equal(readSelfConfig({...env,SELF_LINE_ONE_BUTTON_ENABLED:v}).lineOneButton,false);
 for(const override of [{SELF_LINE_BUTTON_CONFIRM_ENABLED:'false'},{SELF_PROCESSING_ENABLED:'false'},{SELF_PILOT_OWNER_SHA256:''},{LINE_CHANNEL_SECRET:''},{SELF_PUBLIC_ORIGIN:'http://meo.test'},{SELF_LINE_AUTO_PIN_ENABLED:'true'}])
  assert.equal(readSelfConfig({...env,...override}).lineOneButton,false);
 const auto=readSelfConfig({...env,SELF_LINE_AUTO_PIN_ENABLED:'true',SELF_LINE_AUTO_BUTTON_ENABLED:'true'});assert.equal(auto.lineOneButton,true);assert.equal(auto.autoLineButton,true);assert.equal(auto.autoLinePin,false);
 const pin=readSelfConfig({...env,SELF_LINE_AUTO_PIN_ENABLED:'true'});assert.equal(pin.autoLinePin,true);assert.equal(pin.autoLineButton,false);
});
test('manual link card contains one fixed-origin URI, fragment-only PIN metadata, warnings and visible fallback',async t=>{
 const f=await setup(t);await f.db.prepare('UPDATE stores SET title=?').bind('長'.repeat(400)).run();const result=await sendLineButton(f.ctx,f.actor),c=card(f);
 assert.equal(c.url.origin,'https://meo.test');assert.equal(c.url.pathname,'/start');assert.equal(c.url.search,'?openExternalBrowser=1');
 assert.deepEqual([...c.params.keys()],['line-confirm','store','expires']);assert.equal(c.storeId,(await f.store()).id);assert.equal(c.expiresAt,result.expiresAt);assert.equal(c.expiresAt,f.ctx.now()+300000);
 const body=c.message.contents.body.contents.map(x=>x.text).join('\n');assert(body.includes('5分'));assert(body.includes('本人'));assert(body.includes('転送'));assert(body.includes(c.pin));assert(body.includes('長'.repeat(300)));assert(!body.includes('長'.repeat(301)));
 assert(!JSON.stringify(c.message).includes('postback'));const check=await f.db.prepare('SELECT * FROM line_checks').first();assert.notEqual(check.pin_hash,c.pin);assert.equal(check.attempts,0);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);const status=await f.status();assert.equal(status.pinAvailable,true);assert.equal(status.method,'pin');assert.equal(status.expiresAt,c.expiresAt);
 assert.equal((await f.store()).state,'line_pending');assert.equal((await f.store()).termsVersion,null);
});
test('GET return-status and start with the non-secret query are read-only; explicit PIN POST alone verifies',async t=>{
 const f=await setup(t);await sendLineButton(f.ctx,f.actor);const c=card(f),before=await f.snapshot(),handle=await compiledRouter();
 for(let i=0;i<3;i++){
  const status=await getLineReturnStatus(f.ctx,f.request());assert.equal(status.lineOneButton,true);assert.equal(status.lineCheck.pinAvailable,true);
  const text=JSON.stringify(status);assert(!text.includes('"'+c.pin+'"'));assert(!text.includes(c.action.uri));assert(!text.includes('line-fixture'));assert(!text.includes('pin_hash'));
  const start=await handle(f.request(c.url.pathname+c.url.search),f.ctx.env,f.ctx);assert.equal(start.status,200);assert.equal(start.headers.get('Set-Cookie'),null);
 }assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,1);
 await assert.rejects(()=>confirmLineButton(f.ctx,f.actor,{confirmed:true}),e=>e.code==='LINE_CONFIRMATION_INVALID');
 assert.equal((await f.post('activate',{confirmed:true,termsVersion:'fixture-v1'})).status,409);
 assert.equal((await f.post('line/verify',{pin:c.pin})).status,200);assert.equal((await f.store()).state,'line_verified');assert.equal((await f.store()).termsVersion,null);
 assert.equal((await f.post('line/verify',{pin:c.pin})).status,400);assert.equal(f.pushes.length,1);
});
test('new public boolean is absent when unset and false when OFF; two-button cards and plaintext fallback stay compatible',async t=>{
 const f=await setup(t,{overrides:{SELF_LINE_ONE_BUTTON_ENABLED:undefined}});assert(!('lineOneButton' in await getSelfStatus(f.ctx,f.request())));
 await sendLineButton(f.ctx,f.actor);assert.equal(f.pushes[0].messages[0].contents.footer.contents.filter(x=>x.action).length,2);
 f.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='false';assert.equal((await getSelfStatus(f.ctx,f.request())).lineOneButton,false);
 f.advance(60000);await sendLineCheck(f.ctx,f.actor);assert.equal(f.pushes[1].messages[0].type,'text');
});
test('automatic button creates one link card, duplicates never send twice and confirmation is still explicit',async t=>{
 const f=await setup(t,{consume:false,overrides:{SELF_LINE_AUTO_BUTTON_ENABLED:'true',SELF_LINE_AUTO_PIN_ENABLED:'true'}}),tasks=[];
 await f.consumeCode({deferCheck:task=>tasks.push(task)});assert.equal(f.pushes.length,0);assert.equal((await f.status()).state,'awaiting');await tasks[0]();const c=card(f);
 await tasks[0]();await assert.rejects(()=>f.consumeCode(),e=>e.code==='LINE_CODE_INVALID');assert.equal(f.pushes.length,1);
 assert.equal((await f.store()).state,'line_pending');await verifyLinePin(f.ctx,f.actor,c.pin);assert.equal((await f.store()).state,'line_verified');assert.equal((await f.store()).termsVersion,null);
});
test('legacy automatic PIN remains plaintext and manual-only one-button never auto-sends',async t=>{
 await t.test('legacy PIN',async t=>{const f=await setup(t,{consume:false,overrides:{SELF_LINE_AUTO_PIN_ENABLED:'true'}});await f.consumeCode();assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].messages[0].type,'text');assert.equal((await getSelfStatus(f.ctx,f.request())).lineOneButton,false);});
 await t.test('manual only',async t=>{const f=await setup(t);assert.equal(f.pushes.length,0);assert.equal((await f.status()).state,'idle');});
});
test('uncertain automatic link retains reserved capacity and valid fallback, without retrying on GET or duplicate',async t=>{
 const f=await setup(t,{consume:false,overrides:{SELF_LINE_AUTO_BUTTON_ENABLED:'true'}});f.scenario('unknown');const delivered=await f.consumeCode();assert.equal(delivered.checkCode,'LINE_RESULT_UNKNOWN');const c=card(f);
 assert.equal((await f.status()).state,'uncertain');assert.equal((await f.status()).pinAvailable,true);const before=await f.snapshot();for(let i=0;i<3;i++)await getLineReturnStatus(f.ctx,f.request());
 assert.equal(await f.snapshot(),before);await assert.rejects(()=>f.consumeCode(),e=>e.code==='LINE_CODE_INVALID');assert.equal(f.pushes.length,1);
 assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='uncertain'").first()).n,2);
 await verifyLinePin(f.ctx,f.actor,c.pin);assert.equal((await f.store()).state,'line_verified');
});
test('new link cards replace the previous PIN while keeping the daily and minute gates',async t=>{
 const f=await setup(t);await sendLineButton(f.ctx,f.actor);const old=card(f);await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');f.advance(60000);
 await sendLineButton(f.ctx,f.actor);const fresh=card(f);assert.equal(fresh.expiresAt,old.expiresAt+60000);
 // A random six-digit collision is permitted by legacy PIN generation; only distinct old values are invalid credentials.
 if(old.pin!==fresh.pin)await assert.rejects(()=>verifyLinePin(f.ctx,f.actor,old.pin),e=>e.code==='PIN_INVALID');
 await verifyLinePin(f.ctx,f.actor,fresh.pin);assert.equal((await f.store()).state,'line_verified');assert.equal((await f.db.prepare('SELECT used FROM rate_limits WHERE bucket=?').bind(f.dayBucket).first()).used,2);
});
for(const method of ['link','plaintext'])test('new flag '+method+' keeps the consumed original-browser binding alive for the full PIN window',async t=>{
 const f=await setup(t);const original=(await f.db.prepare('SELECT expires_at FROM line_links').first()).expires_at;f.advance(original-f.ctx.now()-1);
 const result=method==='link'?await sendLineButton(f.ctx,f.actor):await sendLineCheck(f.ctx,f.actor);assert.equal((await f.db.prepare('SELECT expires_at FROM line_links').first()).expires_at,result.expiresAt);
 f.advance(2);await purgeExpired(f.ctx);assert.equal((await getLineReturnStatus(f.ctx,f.request())).lineCheck.pinAvailable,true);
 const pin=method==='link'?card(f).pin:f.pushes[0].messages[0].text.match(/確認番号: (\d{6})/)[1];await verifyLinePin(f.ctx,f.actor,pin);assert.equal((await f.store()).state,'line_verified');
});
test('original-browser, owner, CSRF and Origin boundaries are not replaced by possession of the fragment PIN',async t=>{
 const f=await setup(t);await sendLineButton(f.ctx,f.actor);const c=card(f),other=await createSession(f.ctx,'alice'),otherOwner=await createSession(f.ctx,'bob'),before=await f.snapshot();
 assert.equal((await f.post('line/verify',{pin:c.pin},f.session,{'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await f.post('line/verify',{pin:c.pin},f.session,{Origin:'https://attacker.test'})).status,403);assert.equal(await f.snapshot(),before);
 assert.equal((await f.post('line/verify',{pin:c.pin},other)).status,400);assert.equal((await f.post('line/verify',{pin:c.pin},otherOwner)).status,409);
 assert.deepEqual(await getLineReturnStatus(f.ctx,f.request('/api/self/line/return-status',other)),{ok:true,state:'line_return_mismatch',csrf:null});assert.equal((await f.db.prepare('SELECT attempts FROM line_checks').first()).attempts,0);
 assert.equal((await f.post('line/verify',{pin:c.pin})).status,200);
});
for(const invalid of ['PIN expiry','session expiry','generation'])test('link verification rejects '+invalid,async t=>{
 const f=await setup(t);await sendLineButton(f.ctx,f.actor);const c=card(f);
 if(invalid==='PIN expiry')f.advance(300000);if(invalid==='session expiry')await f.db.prepare('UPDATE sessions SET expires_at=?').bind(f.ctx.now()).run();if(invalid==='generation')await f.db.prepare('UPDATE stores SET generation=generation+1').run();
 const response=await f.post('line/verify',{pin:c.pin});assert.equal(response.status,invalid==='session expiry'?401:400);assert.equal((await f.store()).state,'line_pending');
});
test('link fallback PIN is limited to five wrong guesses and valid PIN cannot bypass exhausted attempts',async t=>{
 const f=await setup(t);await sendLineButton(f.ctx,f.actor);const c=card(f),wrong=c.pin==='000000'?'000001':'000000';
 for(let i=0;i<5;i++)await assert.rejects(()=>verifyLinePin(f.ctx,f.actor,wrong),e=>e.code==='PIN_INVALID');assert.equal((await f.db.prepare('SELECT attempts FROM line_checks').first()).attempts,5);
 await assert.rejects(()=>verifyLinePin(f.ctx,f.actor,c.pin),e=>e.code==='PIN_INVALID');assert.equal((await f.status()).pinAvailable,false);assert.equal((await f.store()).state,'line_pending');
});
test('enabling the flag does not break a still-live old signed postback card',async t=>{
 const f=await setup(t,{overrides:{SELF_LINE_ONE_BUTTON_ENABLED:undefined}});await sendLineButton(f.ctx,f.actor);const event=f.oldEvent();f.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='true';
 await receiveLineButton(f.ctx,event);assert.equal((await f.status()).method,'button');await confirmLineButton(f.ctx,f.actor,{confirmed:true});assert.equal((await f.store()).state,'line_verified');
});
test('resending a link card invalidates old postback challenges without faking a receipt',async t=>{
 const f=await setup(t,{overrides:{SELF_LINE_ONE_BUTTON_ENABLED:undefined}});await sendLineButton(f.ctx,f.actor);const event=f.oldEvent();f.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='true';f.advance(60000);await sendLineButton(f.ctx,f.actor);const c=card(f);
 await assert.rejects(()=>receiveLineButton(f.ctx,event),e=>e.code==='LINE_CONFIRMATION_INVALID');await assert.rejects(()=>confirmLineButton(f.ctx,f.actor,{confirmed:true}),e=>e.code==='LINE_CONFIRMATION_INVALID');
 assert.equal((await f.status()).method,'pin');assert.equal((await f.status()).buttonAvailable,false);await verifyLinePin(f.ctx,f.actor,c.pin);
});
for(const scenario of ['quota-full','quota-unknown'])test('one-button '+scenario+' dispatches no card and creates no usable PIN',async t=>{
 const f=await setup(t);f.scenario(scenario);await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code===(scenario==='quota-full'?'QUOTA_EXHAUSTED':'QUOTA_UNKNOWN'));assert.equal(f.pushes.length,0);assert.equal((await f.status()).pinAvailable,false);
});
test('monthly budget and general daily cap still stop one-button dispatch',async t=>{
 await t.test('monthly',async t=>{const f=await setup(t,{overrides:{SELF_MONTHLY_PUSH_LIMIT:'1'}});await sendLineButton(f.ctx,f.actor);card(f);f.advance(60000);await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='QUOTA_EXHAUSTED');assert.equal(f.pushes.length,1);});
 await t.test('daily',async t=>{const f=await setup(t);await f.db.prepare('INSERT INTO rate_limits VALUES (?,3,?)').bind(f.dayBucket,f.ctx.now()+86400000).run();await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');assert.equal(f.pushes.length,0);});
});
test('existing owner-only daily bypass continues through new link cards and OFF restores 3/3',async t=>{
 const f=await setup(t,{overrides:ownerBypass});await f.db.prepare('INSERT INTO rate_limits VALUES (?,3,?)').bind(f.dayBucket,f.ctx.now()+86400000).run();const row=await f.db.prepare('SELECT * FROM rate_limits WHERE bucket=?').bind(f.dayBucket).first();
 await sendLineButton(f.ctx,f.actor);card(f);f.advance(60000);await sendLineButton(f.ctx,f.actor);card(f);assert.equal(f.pushes.length,2);assert.deepEqual(await f.db.prepare('SELECT * FROM rate_limits WHERE bucket=?').bind(f.dayBucket).first(),row);
 f.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='false';f.advance(60000);await assert.rejects(()=>sendLineButton(f.ctx,f.actor),e=>e.code==='RATE_LIMITED');assert.equal((await f.status()).dailySendLimit,3);
});
test('flag closure during automatic quota reservation releases capacity and never dispatches a link',async t=>{
 const f=await setup(t,{consume:false,overrides:{SELF_LINE_AUTO_BUTTON_ENABLED:'true'}});f.onQuota(()=>{f.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='false';});await f.consumeCode();
 assert.equal(f.pushes.length,0);assert.equal((await f.status()).pinAvailable,false);assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='released'").first()).n,2);
});
