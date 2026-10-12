import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv} from '../support/self-runtime.mjs';
import {googleFixture,seedGoogleCredential} from '../support/self-google.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {startGoogle} from '../../worker/self-service/oauth.mjs';
import {selectLocation} from '../../worker/self-service/locations.mjs';
import {claimLocation,countLiveSelfClaims} from '../../worker/self-service/store-repository.mjs';
import {issueLineCode} from '../../worker/self-service/line-link.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';

// Intake slots must not be held by registrations that never start: a squatter
// connecting Google and picking a location (and reissuing LINE codes) loses
// the slot 2h after creating it, or 24h after if LINE was verified.
const T0=Date.parse('2026-09-27T01:00:00Z'), hour=3600000, day=86400000;

async function world(t,{max='2'}={}){
  const {db}=await withD1(t);await applySchema(db);
  const clock={now:T0};
  const f=await googleFixture({now:()=>clock.now});
  const ctx=createSelfContext(fixtureEnv(db,{SELF_MAX_ACTIVE_STORES:max}),{now:()=>clock.now,fetchImpl:async(input,init={})=>{
    const u=new URL(input instanceof Request?input.url:input);
    if(u.hostname==='mybusinessbusinessinformation.googleapis.com')return Response.json({name:u.pathname.slice('/v1/'.length),title:'架空店'});
    return f.fetchImpl(input,init);
  }});
  return {db,clock,ctx};
}
function startRequest(s){
  return new Request('https://meo.test/api/self/google/start',{method:'POST',headers:{Origin:'https://meo.test',Cookie:s.cookie.split(';')[0],'X-CSRF-Token':s.csrf}});
}
async function connect(ctx){
  const s=await createSession(ctx,null);
  return startGoogle(ctx,startRequest(s),{intent:'connect',challenge:'x'});
}
const full=e=>e.code==='CAPACITY_UNAVAILABLE';
async function squat(ctx,sub,i){
  return claimLocation(ctx,{sub,accountId:'accounts/1',locationId:'locations/'+(100+i),title:'架空店'});
}

test('未開始の登録は作成から2時間で受付枠を手放し、LINEコードの出し直しでは延びない',async t=>{
  const {db,clock,ctx}=await world(t);
  await squat(ctx,'squatter0',0);await squat(ctx,'squatter1',1);
  await assert.rejects(connect(ctx),full);
  clock.now=T0+2*hour-60000;
  await issueLineCode(ctx,{sub:'squatter0',sessionHash:'fixture-session'});
  await assert.rejects(connect(ctx),full,'still inside the window');
  clock.now=T0+2*hour+1;
  // Freed before any cleanup ran, although squatter0 touched updated_at a minute ago.
  assert.equal((await db.prepare('SELECT count(*) n FROM stores').first()).n,2);
  assert.equal(await countLiveSelfClaims(ctx),0);
  assert.ok((await connect(ctx)).authorizationUrl);
});

test('LINE確認済みで未開始の登録は作成から24時間、利用開始済みの店舗は期限なく枠を使う',async t=>{
  const {db,clock,ctx}=await world(t);
  const verified=await squat(ctx,'verified',0);
  await db.prepare("UPDATE stores SET state='line_verified',line_user_id='line-v',line_verified_at=? WHERE id=?").bind(T0+hour,verified.id).run();
  const active=await squat(ctx,'active',1);
  await db.prepare("UPDATE stores SET state='active',line_user_id='line-a',line_verified_at=?,terms_version='fixture-v1' WHERE id=?").bind(T0,active.id).run();
  clock.now=T0+day-1;
  assert.equal(await countLiveSelfClaims(ctx),2);
  await assert.rejects(connect(ctx),full);
  clock.now=T0+day+1;
  assert.equal(await countLiveSelfClaims(ctx),1);
  assert.ok((await connect(ctx)).authorizationUrl);
  clock.now=T0+60*day;
  assert.equal(await countLiveSelfClaims(ctx),1,'a started store keeps its slot');
});

test('店舗選択でも受付枠を確かめ直し、同時に選んでも上限を超えない',async t=>{
  const {db,clock,ctx}=await world(t,{max:'1'});
  for(const [sub,n] of [['alice',2],['bob',3]]){
    await seedGoogleCredential(ctx,sub);
    await db.prepare('INSERT INTO location_candidates VALUES (?,?,?,?,?)').bind(sub,'accounts/1','locations/'+n,'架空店',T0+10*day).run();
  }
  // Both owners passed the start-time check while the intake was empty.
  const results=await Promise.allSettled([
    selectLocation(ctx,{sub:'alice'},{accountId:'accounts/1',locationId:'locations/2'}),
    selectLocation(ctx,{sub:'bob'},{accountId:'accounts/1',locationId:'locations/3'}),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results.map(r=>r.reason?.code)));
  const lost=results.find(r=>r.status==='rejected');
  assert.equal(lost.reason.code,'CAPACITY_UNAVAILABLE');
  assert.equal((await db.prepare('SELECT count(*) n FROM stores').first()).n,1);
  const winner=results.find(r=>r.status==='fulfilled').value;
  const [winnerSub,loser]=winner.ownerSub==='alice'?[{sub:'alice'},{sub:'bob',n:3}]:[{sub:'bob'},{sub:'alice',n:2}];
  // The owner of the registration can still select its own location while full.
  assert.equal((await selectLocation(ctx,winnerSub,{accountId:'accounts/1',locationId:winner.locationId})).id,winner.id);
  await assert.rejects(selectLocation(ctx,{sub:loser.sub},{accountId:'accounts/1',locationId:'locations/'+loser.n}),full);
  clock.now=T0+2*hour+1;
  const later=await selectLocation(ctx,{sub:loser.sub},{accountId:'accounts/1',locationId:'locations/'+loser.n});
  assert.equal(later.ownerSub,loser.sub);
});

test('片付けは作成時刻で判定し、LINE確認前は2時間・確認後は24時間で消す',async t=>{
  const {db,clock,ctx}=await world(t,{max:'3'});
  const preLine=await squat(ctx,'pre-line',0);
  const verified=await squat(ctx,'verified',1);
  await db.prepare("UPDATE stores SET state='line_verified',line_user_id='line-v',line_verified_at=? WHERE id=?").bind(T0,verified.id).run();
  const exists=async id=>Boolean(await db.prepare('SELECT 1 FROM stores WHERE id=?').bind(id).first());
  clock.now=T0+2*hour-1;
  await issueLineCode(ctx,{sub:'pre-line',sessionHash:'fixture-session'});
  await purgeExpired(ctx);
  assert.equal(await exists(preLine.id),true);
  clock.now=T0+2*hour+1;
  await purgeExpired(ctx);
  assert.equal(await exists(preLine.id),false,'a fresh updated_at does not keep a pre-LINE registration');
  assert.equal(await db.prepare('SELECT 1 FROM location_claims WHERE store_id=?').bind(preLine.id).first(),null);
  assert.equal(await exists(verified.id),true);
  clock.now=T0+day-1;
  await purgeExpired(ctx);
  assert.equal(await exists(verified.id),true);
  clock.now=T0+day+1;
  await purgeExpired(ctx);
  assert.equal(await exists(verified.id),false);
});

test('片付けの直前にLINE確認が済んだ登録は24時間の枠内なら消さない',async t=>{
  const {db,clock,ctx}=await world(t);
  const store=await squat(ctx,'owner',0);
  await seedGoogleCredential(ctx,'owner');
  clock.now=T0+3*hour;
  let raced=false;
  const raceDb={prepare:sql=>db.prepare(sql),batch:async statements=>{
    if(!raced){
      raced=true;
      await db.prepare("UPDATE stores SET state='line_verified',line_user_id='line-o',line_verified_at=? WHERE id=?").bind(clock.now,store.id).run();
    }
    return db.batch(statements);
  }};
  await purgeExpired({...ctx,db:raceDb});
  assert.equal(raced,true);
  assert.ok(await db.prepare('SELECT 1 FROM stores WHERE id=?').bind(store.id).first());
  assert.ok(await db.prepare("SELECT 1 FROM google_credentials WHERE owner_sub='owner'").first());
});
