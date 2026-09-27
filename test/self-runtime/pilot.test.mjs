import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withD1, applySchema, fixtureEnv, seedStore } from '../support/self-runtime.mjs';
import { pilotSettings } from '../support/self-pilot.mjs';
import { googleFixture, seedGoogleCredential } from '../support/self-google.mjs';
import { createSelfContext } from '../../worker/self-service/config.mjs';
import { createSession } from '../../worker/self-service/session.mjs';
import { startGoogle, finishGoogle } from '../../worker/self-service/oauth.mjs';
import { getSelfStatus } from '../../worker/self-service/status.mjs';
import { discoverLocations, selectLocation } from '../../worker/self-service/locations.mjs';
import { activateStore } from '../../worker/self-service/lifecycle.mjs';
import { issueLineCode, sendLineCheck, consumeLineCode } from '../../worker/self-service/line-link.mjs';
import { runSelfScheduled } from '../../worker/self-service/scheduled.mjs';
import { sendSelfFeedback } from '../../worker/self-service/feedback.mjs';
import { handleSelfPostback } from '../../worker/self-service/approvals.mjs';
const closed = e => e.code === 'REGISTRATION_CLOSED';
function request(s) {
  return new Request('https://meo.test/api/self/google/start', {method:'POST',headers:{Origin:'https://meo.test',Cookie:s.cookie.split(';')[0],'X-CSRF-Token':s.csrf}});
}
function callback(s, url, code) {
  const u = new URL('https://meo.test/api/self/google/callback');
  u.searchParams.set('state', new URL(url).searchParams.get('state'));
  u.searchParams.set('code', code);
  return new Request(u, {headers:{Cookie:s.cookie.split(';')[0]}});
}
async function setup(t, fetchImpl) {
  const {db} = await withD1(t); await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db, await pilotSettings()), {fetchImpl});
  // Sessions refer only to real users (as the production OAuth callback does).
  for (const sub of ['alice','bob']) await db.prepare('INSERT INTO users VALUES (?,?)').bind(sub,ctx.now()).run();
  return ctx;
}
test('pilot rejects anonymous and other account before external I/O; status never exposes owner', async t => {
  const calls=[];
  const ctx=await setup(t, async (...a)=>{calls.push(a); throw Error('UNEXPECTED_IO');});
  for (const sub of [null,'bob','alice']) {
    const s=await createSession(ctx,sub);
    const state=await getSelfStatus(ctx,request(s));
    assert.equal(state.registrationOpen,false);
    assert.equal(state.pilotMode,true);
    assert.equal(state.registrationAllowed,sub==='alice');
    assert.equal(state.processingEnabled,false);
    for (const privateText of ['alice','bob',ctx.env.SELF_PILOT_OWNER_SHA256]) assert(!JSON.stringify(state).includes(privateText));
    if(sub==='alice')continue;
    for(const intent of ['connect', ...(sub?['reconnect']:[])])
      await assert.rejects(()=>startGoogle(ctx,request(s),{intent,challenge:'fixture'}),closed);
    if(sub) {
      await assert.rejects(()=>discoverLocations(ctx,{sub}),closed);
      await assert.rejects(()=>selectLocation(ctx,{sub},{accountId:'accounts/1',locationId:'locations/2'}),closed);
    }
  }
  assert.deepEqual(calls,[]);
});
test('pilot owner connects with zero budgets; callback rejects changed owner or revoked eligibility', async t => {
  const f=await googleFixture();
  const ctx=await setup(t,f.fetchImpl);
  let s=await createSession(ctx,'alice');
  const start=()=>startGoogle(ctx,request(s),{intent:'connect',challenge:'fixture'});
  let {authorizationUrl:url}=await start();
  assert.equal(new URL(url).searchParams.get('scope'),'openid https://www.googleapis.com/auth/business.manage');
  const response=await finishGoogle(ctx,callback(s,url,await f.authorize(url)));
  assert.equal(response.status,303);
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM google_credentials').first()).n,1);
  // Revocation after start must stop before token exchange and preserve prior credential.
  s=await createSession(ctx,'alice');
  ({authorizationUrl:url}=await start());
  const code=await f.authorize(url), before=f.calls.length;
  delete ctx.env.SELF_PILOT_OWNER_SHA256;
  await assert.rejects(()=>finishGoogle(ctx,callback(s,url,code)),closed);
  assert.equal(f.calls.length,before);
  Object.assign(ctx.env,await pilotSettings());
  const other=await googleFixture({sub:'bob'}); ctx.fetchImpl=other.fetchImpl;
  ({authorizationUrl:url}=await start());
  await assert.rejects(async ()=>finishGoogle(ctx,callback(s,url,await other.authorize(url))), e=>e.code==='GOOGLE_ACCOUNT_MISMATCH');
  assert.equal(await ctx.db.prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub='bob'").first(),null);
});
test('pilot selection is one store even concurrently and preserves legacy claims', async t => {
  const calls=[];
  const ctx=await setup(t,async input=>{
    const u=new URL(input); calls.push(u.pathname);
    if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
    if(u.pathname==='/v1/accounts')return Response.json({accounts:[{name:'accounts/1'}]});
    if(u.pathname==='/v1/accounts/1/locations')return Response.json({locations:[2,3,4].map(i=>({name:'locations/'+i,title:'架空店'+i}))});
    return Response.json({name:u.pathname.slice(4),title:'架空店'});
  });
  await seedGoogleCredential(ctx);
  await ctx.db.prepare("INSERT INTO location_claims(location_id,store_id,mode) VALUES ('locations/4','legacy:fixture','legacy')").run();
  await discoverLocations(ctx,{sub:'alice'});
  await assert.rejects(()=>selectLocation(ctx,{sub:'alice'},{accountId:'accounts/1',locationId:'locations/4'}),e=>e.code==='LOCATION_UNAVAILABLE');
  const results=await Promise.allSettled([2,3].map(i=>selectLocation(ctx,{sub:'alice'},{accountId:'accounts/1',locationId:'locations/'+i})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await ctx.db.prepare("SELECT count(*) n FROM location_claims WHERE mode='self'").first()).n,1);
  assert.equal((await ctx.db.prepare("SELECT count(*) n FROM location_claims WHERE mode='legacy'").first()).n,1);
  assert.equal((await ctx.db.prepare('SELECT state FROM stores').first()).state,'location_selected');
});
test('pilot blocks activation, LINE setup and all self processing even if processing flag is enabled', async t => {
  const calls=[];
  const ctx=await setup(t,async (...a)=>{calls.push(a);throw Error('UNEXPECTED_IO');});
  const store=await seedStore(ctx); // Simulate an old active row and stale LINE event.
  ctx.env.SELF_PROCESSING_ENABLED='true';
  const actor={sub:'alice',sessionHash:'fixture'};
  await assert.rejects(()=>activateStore(ctx,actor,{termsVersion:'fixture-v1',confirmed:true}),e=>e.code==='ACTIVATION_NOT_READY');
  for(const action of [issueLineCode,sendLineCheck]) await assert.rejects(()=>action(ctx,actor),e=>e.code==='PROCESSING_CLOSED');
  await consumeLineCode(ctx,{message:{text:'MEOS-AAAAAAAAAAAA'},source:{type:'user',userId:'line-a'}});
  await runSelfScheduled(ctx);
  const event={postback:{data:'approve:ss_fixture'},source:{type:'user',userId:'line-a'},webhookEventId:'fixture-event',replyToken:'fixture-reply'};
  assert.equal((await handleSelfPostback(ctx,event)).code,'PROCESSING_CLOSED');
  // Feedback must short-circuit before looking up even an existing stale reply.
  await sendSelfFeedback({...ctx,db:{prepare(){throw Error('PILOT_FEEDBACK_MUST_NOT_LOOKUP');}}},event,{code:'PROCESSING_CLOSED'});
  assert.deepEqual(calls,[]);
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM line_links').first()).n,0);
});

test('location request cannot override validated owner through body sub', async t => {
  const ctx=await setup(t,async input=>new URL(input).hostname==='oauth2.googleapis.com'
    ? Response.json({access_token:'fixture'}) : Response.json({name:'locations/2',title:'架空店'}));
  await seedGoogleCredential(ctx);
  await ctx.db.prepare("INSERT INTO location_candidates(owner_sub,account_id,location_id,title,expires_at) VALUES ('alice','accounts/1','locations/2','架空店',?)").bind(ctx.now()+600000).run();
  await selectLocation(ctx,{sub:'alice'},{sub:'bob',accountId:'accounts/1',locationId:'locations/2',title:'injected',mode:'legacy'});
  assert.equal((await ctx.db.prepare('SELECT owner_sub FROM stores').first()).owner_sub,'alice');
  assert.equal((await ctx.db.prepare('SELECT mode FROM location_claims').first()).mode,'self');
});
test('existing-store pilot reconnect cannot survive removal of pilot setting, but normal reconnect can', async t => {
  const f=await googleFixture(); const ctx=await setup(t,f.fetchImpl);
  await seedStore(ctx,{state:'location_selected'});
  const s=await createSession(ctx,'alice');
  const {authorizationUrl:url}=await startGoogle(ctx,request(s),{intent:'reconnect',challenge:'fixture'});
  const code=await f.authorize(url), before=f.calls.length;
  delete ctx.env.SELF_PILOT_OWNER_SHA256;
  await assert.rejects(()=>finishGoogle(ctx,callback(s,url,code)),closed);
  assert.equal(f.calls.length,before);
  const {authorizationUrl:normal}=await startGoogle(ctx,request(s),{intent:'reconnect',challenge:'fixture'});
  const response=await finishGoogle(ctx,callback(s,normal,await f.authorize(normal)));
  assert.equal(response.status,303);
});
