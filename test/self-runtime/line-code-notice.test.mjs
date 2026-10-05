import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1, applySchema, fixtureEnv, seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {issueLineCode, consumeLineCode} from '../../worker/self-service/line-link.mjs';
import * as feedback from '../../worker/self-service/feedback.mjs';

async function setup(t) {
  const {db} = await withD1(t); await applySchema(db);
  let now = Date.now();
  const calls = [];
  const ctx = createSelfContext(fixtureEnv(db), {now: () => now, fetchImpl: async (u,i) => {
    calls.push({url: String(u), body: JSON.parse(i.body)}); return Response.json({});
  }});
  const store = await seedStore(ctx, {state:'location_selected', lineUserId:null});
  const {code} = await issueLineCode(ctx, {sub:'alice',sessionHash:'fixture-session'});
  const event = (extra = {}) => ({type:'message', webhookEventId:crypto.randomUUID(), replyToken:'fixture-reply', source:{type:'user', userId:'line-new'}, message:{type:'text',text:code}, ...extra});
  return {ctx,db,store,code,calls,event,advance:ms => now += ms};
}
async function notice(ctx,event) {
  assert.equal(typeof feedback.sendSelfCodeNotice, 'function', 'invalid-code feedback must be available to the webhook');
  return feedback.sendSelfCodeNotice(ctx,event);
}
test('LINE-04/START-13: expired code replies once with recovery instructions, no private data or push', async t => {
  const f = await setup(t); f.advance(15 * 60000 + 1);
  const e = f.event();
  await assert.rejects(consumeLineCode(f.ctx,e), {code:'LINE_CODE_INVALID'});
  await notice(f.ctx,e);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'https://api.line.me/v2/bot/message/reply');
  assert.equal(f.calls[0].body.replyToken,e.replyToken);
  assert.equal(f.calls[0].body.messages.length,1);
  const text = f.calls[0].body.messages[0].text;
  assert.match(text,/15分|古いコード/);
  assert.match(text,/Safari・Chrome/);
  assert.match(text,/再発行/);
  assert.doesNotMatch(text,/MEOS-|line-new|https?:/);
  await notice(f.ctx,e);
  assert.equal(f.calls.length,1);
  assert.equal((await f.db.prepare("SELECT used FROM usage_budgets WHERE kind='reply'").first()).used,1);
  assert.equal(await f.db.prepare("SELECT used FROM usage_budgets WHERE kind='push'").first(),null);
});
test('LINE-04: pending confirmation and already registered users remain silent', async t => {
  const f = await setup(t);
  await f.db.prepare("UPDATE stores SET pending_line_user_id='line-new' WHERE id=?").bind(f.store.id).run();
  await notice(f.ctx,f.event());
  for (const state of ['line_verified','ready','active','paused']) {
    await f.db.prepare("UPDATE stores SET state=?,line_user_id='line-new',pending_line_user_id=NULL WHERE id=?").bind(state,f.store.id).run();
    await notice(f.ctx,f.event());
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
});
test('LINE-04: redelivery, groups, pilot and malformed delivery metadata stay silent', async t => {
  const f = await setup(t);
  for (const extra of [
    {deliveryContext:{isRedelivery:true}}, {source:{type:'group', userId:'line-new'}},
    {source:{type:'user'}}, {source:{type:'user',userId:''}},
    {replyToken:undefined}, {replyToken:''}, {replyToken:'a'.repeat(4097)}, {replyToken:42},
    {webhookEventId:undefined}, {webhookEventId:''},
  ]) await notice(f.ctx,f.event(extra));
  await notice({...f.ctx,env:{...f.ctx.env,SELF_PILOT_OWNER_SHA256:''}},f.event());
  await notice({...f.ctx,env:{...f.ctx.env,LINE_CHANNEL_ACCESS_TOKEN:''}},f.event());
  assert.equal(f.calls.length,0);
});
test('LINE-04: notice rate is three per user per ten minutes', async t => {
  const f = await setup(t);
  for (let i=0;i<4;i++) await notice(f.ctx,f.event());
  assert.equal(f.calls.length,3);
  await notice(f.ctx,f.event({source:{type:'user',userId:'other-user'}}));
  assert.equal(f.calls.length,4);
  f.advance(10*60000+1);
  await notice(f.ctx,f.event());
  assert.equal(f.calls.length,5);
});
test('LINE-04: failed replies are not retried or replaced with push', async t => {
  const f = await setup(t);
  let attempts=0;
  const ctx={...f.ctx,fetchImpl:async u=>{attempts++;assert.equal(u,'https://api.line.me/v2/bot/message/reply');throw Error('fixture unavailable');}};
  const e=f.event();
  await notice(ctx,e);await notice(ctx,e);
  assert.equal(attempts,1);
  assert.equal((await f.db.prepare("SELECT state FROM usage_reservations WHERE kind='reply'").first()).state,'uncertain');
});

test('LINE-04: signed webhook routes invalid MEOS codes to reply-only notices', async t => {
  const {default: worker} = await import('../../worker/index.mjs');
  const {hmac} = await import('../../worker/self-service/crypto.mjs');
  const f = await setup(t);
  await f.db.prepare('UPDATE line_links SET expires_at=?').bind(Date.now()-1).run();
  t.mock.method(globalThis, 'fetch', f.ctx.fetchImpl);
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')));
  async function send(e, validSignature=true) {
    const body=JSON.stringify({events:[e]}); const pending=[];
    const response=await worker.fetch(new Request('https://meo.test/webhook/line-bot',{
      method:'POST',body,headers:{'X-Line-Signature':validSignature?await hmac(body,f.ctx.env.LINE_CHANNEL_SECRET):'invalid'},
    }),f.ctx.env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);return response;
  }
  const e=f.event();
  assert.equal((await send(e,false)).status,401);
  assert.equal(f.calls.length,0);
  assert.equal((await send(e)).status,200);
  assert.equal(f.calls.length,1);
  assert.ok(errors.some(x=>x.includes('LINE_CODE_INVALID')));
  await send(e);
  assert.equal(f.calls.length,1);
  await send(f.event({message:{type:'text',text:'MEOS-invalid'}}));
  assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(x=>x.url.endsWith('/reply')));
});
