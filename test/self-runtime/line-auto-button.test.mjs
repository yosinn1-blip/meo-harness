import test from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {issueLineCode,consumeLineCode,sendLineButton,sendLineCheck} from '../../worker/self-service/line-link.mjs';
import {receiveLineButton,confirmLineButton} from '../../worker/self-service/line-button-confirm.mjs';
import {readLineCheckStatus} from '../../worker/self-service/line-check-delivery.mjs';
import {findOwnedStore} from '../../worker/self-service/store-repository.mjs';
import {disconnectStore} from '../../worker/self-service/lifecycle.mjs';
const actor={sub:'alice',sessionHash:'original-browser'};
const codeEvent=(code,userId='line-a')=>({type:'message',source:{type:'user',userId},message:{type:'text',text:code}});
async function setup(t,options={}) {
 const {db}=await withD1(t);await applySchema(db);let now=100000,scenario='ok',quotaHook=null;
 const pushes=[];
 const ctx=createSelfContext(fixtureEnv(db,{SELF_LINE_BUTTON_CONFIRM_ENABLED:'true',SELF_LINE_AUTO_BUTTON_ENABLED:'true',...options}),{
  now:()=>now,fetchImpl:async(url,init={})=>{
   assert.equal(new URL(url).origin,'https://api.line.me');
   if(url.endsWith('/quota')){if(quotaHook){const h=quotaHook;quotaHook=null;await h();}return scenario==='quota-unknown'?new Response(null,{status:500}):Response.json({type:'limited',value:200});}
   if(url.endsWith('/consumption'))return Response.json({totalUsage:scenario==='quota-full'?200:0});
   assert(url.endsWith('/push'));pushes.push(JSON.parse(init.body));
   if(scenario==='unknown')throw Error('fixture ambiguous dispatch');
   if(scenario==='failed')return new Response(null,{status:400});return Response.json({});
  }
 });
 const store=await seedStore(ctx,{state:'location_selected',lineUserId:null});
 await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,NULL)').bind(actor.sessionHash,actor.sub,'csrf',now+86400000,now).run();
 const {code}=await issueLineCode(ctx,actor);
 const status=async()=>readLineCheckStatus(ctx,await findOwnedStore(ctx,actor.sub),actor.sessionHash);
 const snapshot=async()=>{const names=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(names.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
 return {db,ctx,store,code,pushes,status,snapshot,advance:n=>now+=n,scenario:s=>scenario=s,onQuota:fn=>quotaHook=fn,
  event:()=>({type:'postback',source:{type:'user',userId:'line-a'},postback:{data:pushes.at(-1).messages[0].contents.footer.contents[0].action.data}})};
}
test('automatic code sends exactly one numbered Flex even with legacy autoPIN ON; explicit owner finalization remains',async t=>{
 const f=await setup(t,{SELF_LINE_AUTO_PIN_ENABLED:'true'});await consumeLineCode(f.ctx,codeEvent(f.code));
 assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].to,'line-a');const msg=f.pushes[0].messages[0];
 assert.equal(msg.type,'flex');assert.deepEqual(msg.contents.footer.contents.slice(0,2).map(x=>x.action.label),['1 このLINEで確認','2 登録画面へ戻る']);
 assert.equal(msg.contents.footer.contents[0].action.type,'postback');assert.equal(msg.contents.footer.contents[1].action.uri,'https://meo.test/start?openExternalBrowser=1');
 assert.equal((await f.db.prepare('SELECT count(*) n FROM line_checks').first()).n,0);
 assert.equal((await f.status()).buttonAvailable,false);await assert.rejects(()=>confirmLineButton(f.ctx,actor,{confirmed:true}));
 const before=await f.snapshot();for(let i=0;i<3;i++)await f.status();assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,1);
 await receiveLineButton(f.ctx,f.event());assert.equal((await f.status()).buttonAvailable,true);
 assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_pending');
 await confirmLineButton(f.ctx,actor,{confirmed:true});assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_verified');
 assert.equal((await findOwnedStore(f.ctx,actor.sub)).termsVersion,null);
});
test('lost automatic task waits only twenty seconds from consumption; GETs never claim or extend the wait',async t=>{
 const f=await setup(t),tasks=[];await consumeLineCode(f.ctx,codeEvent(f.code),{deferCheck:task=>tasks.push(task)});
 assert.equal(tasks.length,1);const before=await f.snapshot();assert.equal((await f.status()).state,'awaiting');assert.equal((await f.status()).retryAfterMs,20000);
 f.advance(17000);assert.equal((await f.status()).retryAfterMs,3000);f.advance(3000);
 assert.equal((await f.status()).state,'held');assert.equal((await f.status()).code,'LINE_RETRY_REQUIRED');
 assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,0);
 await sendLineButton(f.ctx,actor);assert.equal(f.pushes.length,1);await tasks[0]();assert.equal(f.pushes.length,1);
});
test('concurrent and duplicate code events never change the winner or push twice',async t=>{
 const f=await setup(t);const results=await Promise.allSettled([consumeLineCode(f.ctx,codeEvent(f.code)),consumeLineCode(f.ctx,codeEvent(f.code,'line-other'))]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.pushes.length,1);
 assert.equal((await f.db.prepare('SELECT pending_line_user_id FROM stores').first()).pending_line_user_id,f.pushes[0].to);
 await assert.rejects(()=>consumeLineCode(f.ctx,codeEvent(f.code)));assert.equal(f.pushes.length,1);
});
for(const mode of ['button','pin'])for(const change of ['revoked','expired','owner','store-owner','generation','binding','clock-expiry','code-expiry'])
 test('atomic automatic '+mode+' intake rolls back after snapshot '+change,async t=>{
  const f=await setup(t,mode==='pin'?{SELF_LINE_AUTO_BUTTON_ENABLED:'false',SELF_LINE_AUTO_PIN_ENABLED:'true'}:{});
  const wrapped={prepare(sql){const statement=f.db.prepare(sql);if(!sql.startsWith('SELECT l.*,s.owner_sub,s.generation'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async first(){const result=await bound.first();
    if(change==='revoked')await f.db.prepare('DELETE FROM sessions').run();
    if(change==='expired')await f.db.prepare('UPDATE sessions SET expires_at=0').run();
    if(change==='owner')await f.db.prepare("UPDATE sessions SET owner_sub='bob'").run();
    if(change==='store-owner')await f.db.batch([f.db.prepare("INSERT INTO users(sub,created_at) VALUES ('bob',0)"),f.db.prepare("UPDATE stores SET owner_sub='bob'"),f.db.prepare("UPDATE sessions SET owner_sub='bob'")]);
    if(change==='generation')await f.db.prepare('UPDATE stores SET generation=generation+1').run();
    if(change==='binding')await f.db.prepare("UPDATE line_links SET session_hash='another-browser'").run();
    if(change==='clock-expiry')f.advance(86400001);if(change==='code-expiry')f.advance(900001);return result;}};}};},batch:statements=>f.db.batch(statements)};
  await assert.rejects(()=>consumeLineCode({...f.ctx,db:wrapped},codeEvent(f.code)),e=>e.code==='LINE_CODE_INVALID');
  assert.equal((await f.db.prepare('SELECT consumed_at FROM line_links').first()).consumed_at,null);
  assert.equal((await f.db.prepare('SELECT pending_line_user_id FROM stores').first()).pending_line_user_id,null);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM mutation_guards').first()).n,0);assert.equal(f.pushes.length,0);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
 });
for(const scenario of ['quota-full','quota-unknown','unknown','failed'])test('automatic '+scenario+' never retries on status or duplicate; explicit recovery keeps shared quotas',async t=>{
 const f=await setup(t);f.scenario(scenario);await consumeLineCode(f.ctx,codeEvent(f.code));
 assert.equal((await f.status()).state,scenario==='unknown'?'uncertain':scenario==='failed'?'failed':'held');
 const expected=['unknown','failed'].includes(scenario)?1:0;assert.equal(f.pushes.length,expected);
 const before=await f.snapshot();for(let i=0;i<3;i++)await f.status();assert.equal(await f.snapshot(),before);
 await assert.rejects(()=>consumeLineCode(f.ctx,codeEvent(f.code)));assert.equal(f.pushes.length,expected);
 assert.equal((await findOwnedStore(f.ctx,actor.sub)).state,'line_pending');
 if(scenario==='unknown') {
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='uncertain' AND kind='push'").first()).n,1);
  await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});
 } else {f.scenario('ok');f.advance(60001);await sendLineButton(f.ctx,actor);await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});}
});
for(const change of ['auto-off','button-off','processing-off','reissue','disconnect','session-revoke','generation','owner'])
 test('automatic Flex stops after quota if '+change+' and never falls back to PIN',async t=>{
  const f=await setup(t,{SELF_LINE_AUTO_PIN_ENABLED:'true'});
  f.onQuota(async()=>{
   if(change==='auto-off')f.ctx.env.SELF_LINE_AUTO_BUTTON_ENABLED='false';
   if(change==='button-off')f.ctx.env.SELF_LINE_BUTTON_CONFIRM_ENABLED='false';
   if(change==='processing-off')f.ctx.env.SELF_PROCESSING_ENABLED='false';
   if(change==='reissue')await issueLineCode(f.ctx,actor);
   if(change==='disconnect')await disconnectStore(f.ctx,actor);
   if(change==='session-revoke')await f.db.prepare('DELETE FROM sessions').run();
   if(change==='generation')await f.db.prepare('UPDATE stores SET generation=generation+1').run();
   if(change==='owner')await f.db.prepare("UPDATE sessions SET owner_sub='bob'").run();
  });await consumeLineCode(f.ctx,codeEvent(f.code));assert.equal(f.pushes.length,0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state<>'released'").first()).n,0);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM line_checks').first()).n,0);
 });
test('queued task after opt-out sends nothing; deliberate PIN fallback and button resend retain one-minute/day caps',async t=>{
 const f=await setup(t),tasks=[];await consumeLineCode(f.ctx,codeEvent(f.code),{deferCheck:task=>tasks.push(task)});
 f.ctx.env.SELF_LINE_AUTO_BUTTON_ENABLED='false';await tasks[0]();assert.equal(f.pushes.length,0);
 f.ctx.env.SELF_LINE_AUTO_BUTTON_ENABLED='true';await sendLineButton(f.ctx,actor);const old=f.event();
 await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='RATE_LIMITED');f.advance(60001);await sendLineCheck(f.ctx,actor);
 await assert.rejects(()=>receiveLineButton(f.ctx,old));assert.equal(f.pushes[1].messages[0].type,'text');
 f.advance(60001);await sendLineButton(f.ctx,actor);f.advance(60001);await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='RATE_LIMITED');
 assert.equal(f.pushes.length,3);f.advance(300001);assert.equal((await f.status()).buttonExpired,true);
 await assert.rejects(()=>receiveLineButton(f.ctx,f.event()));assert.equal((await f.status()).buttonAvailable,false);
});
test('manual click while automatic Flex reserves quota cannot replace the nonce or dispatch twice',async t=>{
 const f=await setup(t);let release,entered;const waiting=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 f.onQuota(async()=>{entered(true);await waiting;});const automatic=consumeLineCode(f.ctx,codeEvent(f.code));
 assert.equal(await Promise.race([reached,automatic.then(()=>false)]),true);
 const before=JSON.stringify(await f.db.prepare('SELECT * FROM line_button_checks').first());
 await assert.rejects(()=>sendLineButton(f.ctx,actor),e=>e.code==='LINE_CHECK_BUSY');
 assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM line_button_checks').first()),before);
 release();await automatic;assert.equal(f.pushes.length,1);await receiveLineButton(f.ctx,f.event());await confirmLineButton(f.ctx,actor,{confirmed:true});
});
