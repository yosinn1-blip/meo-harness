import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {seedGoogleCredential} from '../support/self-google.mjs';
import {googleAccessToken} from '../../worker/self-service/google.mjs';
import {issueLineCode} from '../../worker/self-service/line-link.mjs';
import {activateStore} from '../../worker/self-service/lifecycle.mjs';

const now = Date.parse('2026-09-27T01:00:00Z');
const day = 86400000;
for (const initialState of ['line_verified', 'active']) {
  test(`expired Google credentials respect onboarding retention for ${initialState}`, async t => {
    const {db}=await withD1(t);await applySchema(db);
    let clock=now;
    const ctx=createSelfContext(fixtureEnv(db),{
      now:()=>clock,
      fetchImpl:async (url, init)=>{
        assert.equal(url,'https://oauth2.googleapis.com/token');
        assert.equal(init.method,'POST');
        return Response.json({error:'invalid_grant'},{status:400});
      },
    });
    const store=await seedStore(ctx,{state:initialState});
    await seedGoogleCredential(ctx);
    await assert.rejects(googleAccessToken(ctx,'alice'),{code:'GOOGLE_RECONNECT_REQUIRED'});
    assert.equal((await db.prepare('SELECT state FROM stores WHERE id=?').bind(store.id).first()).state,'needs_google_reconnect');
    clock+=day-1;
    await purgeExpired(ctx);
    assert.ok(await db.prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub='alice'").first());
    clock+=2;
    await purgeExpired(ctx);
    const retained=initialState==='active';
    for(const [table,column,value] of [['stores','id',store.id],['google_credentials','owner_sub','alice'],['location_claims','store_id',store.id]]) {
      assert.equal(Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).bind(value).first()),retained,`${table}: only previously activated stores may retain a reconnecting account`);
    }
  });
}
test('never-activated reconnect can be paused without escaping the 24-hour cleanup', async t => {
  const {db}=await withD1(t);await applySchema(db);
  let clock=now;
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>clock});
  const store=await seedStore(ctx,{state:'line_verified'});
  await seedGoogleCredential(ctx);
  // A successful reconnect after LINE verification returns to paused without
  // setting terms_version; only activateStore records acceptance.
  await db.prepare("UPDATE stores SET state='paused' WHERE id=?").bind(store.id).run();
  clock+=day+1;
  await purgeExpired(ctx);
  assert.equal(await db.prepare('SELECT id FROM stores WHERE id=?').bind(store.id).first(),null);
  assert.equal(await db.prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub='alice'").first(),null);
});
test('LINE relinking cannot make an activated store eligible for abandoned-signup deletion', async t => {
  const {db}=await withD1(t);await applySchema(db);
  let clock=now;
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>clock});
  const store=await seedStore(ctx);
  await seedGoogleCredential(ctx);
  await issueLineCode(ctx,{sub:'alice',sessionHash:'fixture-session'});
  clock+=2*day;
  await purgeExpired(ctx);
  const row=await db.prepare('SELECT state,terms_version FROM stores WHERE id=?').bind(store.id).first();
  assert.deepEqual(row,{state:'line_pending',terms_version:'fixture-v1'});
  assert.ok(await db.prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub='alice'").first());
});
for (const change of ['activate','refresh']) {
  test(`retention rechecks abandonment atomically when ${change} wins the cleanup race`, async t => {
    const {db}=await withD1(t);await applySchema(db);
    let clock=now;
    const ctx=createSelfContext(fixtureEnv(db),{now:()=>clock,fetchImpl:async u=>
      Response.json(String(u).includes('/token')?{access_token:'fixture'}:{name:'locations/2',title:'架空店'})});
    const store=await seedStore(ctx,{state:'line_verified'});
    await seedGoogleCredential(ctx);
    clock+=2*day;
    let raced=false;
    const raceDb={prepare:sql=>db.prepare(sql),batch:async statements=>{
      if(!raced){
        raced=true;
        if(change==='activate') await activateStore(ctx,{sub:'alice'},{confirmed:true,termsVersion:'fixture-v1'});
        else await issueLineCode(ctx,{sub:'alice',sessionHash:'fixture-session'});
      }
      return db.batch(statements);
    }};
    await purgeExpired({...ctx,db:raceDb});
    assert.equal(raced,true);
    assert.ok(await db.prepare('SELECT id FROM stores WHERE id=?').bind(store.id).first());
    assert.ok(await db.prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub='alice'").first());
    assert.ok(await db.prepare('SELECT store_id FROM location_claims WHERE store_id=?').bind(store.id).first());
  });
}
async function seedUsage(db, {id,period,kind='push',state='committed',created=now-150*day,scope='channel'}) {
  await db.prepare('INSERT OR IGNORE INTO usage_budgets VALUES (?,?,?,1000,0)').bind(scope,period,kind).run();
  await db.prepare('INSERT INTO usage_reservations VALUES (?,?,?,?,1,?,?)').bind(id,scope,period,kind,state,created).run();
}
test('old monthly usage expires without resetting current caps or recent reservations', async t => {
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
  for (const state of ['committed','released','uncertain','reserved'])
    await seedUsage(db,{id:'old-'+state,period:'2026-05',state});
  await seedUsage(db,{id:'current',period:'2026-09',created:now-2*day});
  await seedUsage(db,{id:'not-90-days-since-month-end',period:'2026-06'});
  await seedUsage(db,{id:'recent-old-period',period:'2026-04',created:now-2*day});
  await seedUsage(db,{id:'lifetime',period:'lifetime',kind:'active'});
  await purgeExpired(ctx);
  assert.deepEqual((await db.prepare('SELECT id FROM usage_reservations ORDER BY id').all()).results.map(r=>r.id),
    ['current','lifetime','not-90-days-since-month-end','recent-old-period']);
  assert.equal(await db.prepare("SELECT * FROM usage_budgets WHERE period='2026-05'").first(),null);
  assert.equal((await db.prepare("SELECT used FROM usage_budgets WHERE period='2026-09'").first()).used,1);
  assert.ok(await db.prepare("SELECT * FROM usage_budgets WHERE period='2026-04'").first());
  await purgeExpired(ctx);
  assert.equal((await db.prepare("SELECT used FROM usage_budgets WHERE period='2026-09'").first()).used,1);
});
test('cleanup keeps active-slot reservations and only removes released orphan slots', async t => {
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
  const store=await seedStore(ctx);
  await seedUsage(db,{id:'active:'+store.id,period:'lifetime',kind:'active',state:'released',scope:'global'});
  await seedUsage(db,{id:'active:orphan',period:'lifetime',kind:'active',state:'released',scope:'global'});
  await seedUsage(db,{id:'active:held',period:'lifetime',kind:'active',state:'reserved',scope:'global'});
  const before=await db.prepare("SELECT used FROM usage_budgets WHERE kind='active'").first();
  await purgeExpired(ctx);
  assert.equal(await db.prepare("SELECT id FROM usage_reservations WHERE id='active:orphan'").first(),null);
  assert.ok(await db.prepare('SELECT id FROM usage_reservations WHERE id=?').bind('active:'+store.id).first());
  assert.ok(await db.prepare("SELECT id FROM usage_reservations WHERE id='active:held'").first());
  assert.deepEqual(await db.prepare("SELECT used FROM usage_budgets WHERE kind='active'").first(),before);
});
test('monthly cleanup is bounded and does not discard a budget with remaining reservations', async t => {
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
  for(let i=0;i<105;i++)await seedUsage(db,{id:'old-'+i,period:'2026-05'});
  await purgeExpired(ctx);
  assert.equal((await db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,5);
  assert.ok(await db.prepare("SELECT * FROM usage_budgets WHERE period='2026-05'").first());
  await purgeExpired(ctx);
  assert.equal((await db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
  assert.equal(await db.prepare("SELECT * FROM usage_budgets WHERE period='2026-05'").first(),null);
});
test('monthly and released active reservations share one 100-row cleanup limit', async t => {
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
  for(let i=0;i<80;i++)await seedUsage(db,{id:'old-'+i,period:'2026-05'});
  for(let i=0;i<80;i++)await seedUsage(db,{id:'active:orphan-'+i,period:'lifetime',kind:'active',state:'released',scope:'global'});
  await purgeExpired(ctx);
  assert.equal((await db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,60);
  await purgeExpired(ctx);
  assert.equal((await db.prepare('SELECT count(*) n FROM usage_reservations').first()).n,0);
});
test('unfinished user identities expire without removing live sessions, OAuth or stores', async t => {
  const {db}=await withD1(t);await applySchema(db);
  let clock=now;
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>clock});
  await seedStore(ctx);
  for(const sub of ['abandoned','logged-in','oauth-in-progress','connected','recent'])
    await db.prepare('INSERT INTO users VALUES (?,?)').bind(sub,sub==='recent'?now:now-2*day).run();
  await seedGoogleCredential(ctx,'abandoned');
  await db.prepare('UPDATE google_credentials SET updated_at=? WHERE owner_sub=?').bind(now-2*day,'abandoned').run();
  await seedGoogleCredential(ctx,'connected');
  await createSession(ctx,'logged-in');
  await db.prepare('INSERT INTO oauth_attempts VALUES (?,?,?,?,?,?,?,?,?)')
    .bind('fixture-attempt','fixture-session','connect','fixture-cipher','fixture-nonce','oauth-in-progress',null,null,now+600000).run();
  await purgeExpired(ctx);
  assert.equal(await db.prepare("SELECT sub FROM users WHERE sub='abandoned'").first(),null);
  assert.deepEqual((await db.prepare('SELECT sub FROM users ORDER BY sub').all()).results.map(r=>r.sub),
    ['alice','connected','logged-in','oauth-in-progress','recent']);
  clock+=2*day;
  await purgeExpired(ctx);
  assert.deepEqual((await db.prepare('SELECT sub FROM users ORDER BY sub').all()).results.map(r=>r.sub),['alice']);
});
