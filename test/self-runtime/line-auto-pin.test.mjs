import { test } from "node:test";
import assert from "node:assert/strict";
import { withD1, applySchema, fixtureEnv, seedStore } from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import { issueLineCode, consumeLineCode, sendLineCheck, verifyLinePin } from "../../worker/self-service/line-link.mjs";
import { disconnectStore } from "../../worker/self-service/lifecycle.mjs";
const actor = { sub: "alice", sessionHash: "browser-a" };
const event = (code, userId = "line-a") => ({ type: "message", source: { type: "user", userId }, message: { type: "text", text: code } });
async function setup(t, options = {}) {
  const { db } = await withD1(t); await applySchema(db);
  let now = 10000; const pushes = []; let scenario = "ok", onQuota = null;
  const ctx = createSelfContext(fixtureEnv(db, { SELF_LINE_AUTO_PIN_ENABLED: "true", ...options }), {
    now: () => now,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/quota")) {
        if (onQuota) { const fn=onQuota; onQuota=null; await fn(); }
        return scenario === "quota-unknown" ? new Response(null,{status:500}) : Response.json({ type:"limited", value:200 });
      }
      if (url.endsWith("/consumption")) return Response.json({ totalUsage: scenario === "quota-full" ? 200 : 0 });
      if (url.endsWith("/push")) {
        pushes.push(JSON.parse(init.body));
        if (scenario === "unknown") throw new Error("fixture timeout after dispatch");
        if (scenario === "failed") return new Response(null, {status:400});
        return Response.json({}, { headers:{"x-line-request-id":"fixture-accepted"} });
      }
      throw new Error("UNEXPECTED_EXTERNAL_IO");
    },
  });
  const store=await seedStore(ctx,{state:"location_selected",lineUserId:null});
  await db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,NULL)").bind(actor.sessionHash,actor.sub,"csrf",now+86400000,now).run();
  return {db,ctx,store,pushes,advance(ms){now+=ms;},setScenario(value){scenario=value;},onQuota(fn){onQuota=fn;},pin(){return pushes.at(-1)?.messages[0].text.match(/確認番号: (\d{6})/)[1];}};
}
test("a valid LINE code sends one PIN before browser return and still requires same-browser verification", async t => {
  const f=await setup(t);const code=await issueLineCode(f.ctx,actor);
  await consumeLineCode(f.ctx,event(code.code));
  assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].to,"line-a");
  await assert.rejects(()=>verifyLinePin(f.ctx,{...actor,sessionHash:"browser-other"},f.pin()),e=>e.code==="PIN_INVALID");
  assert.equal((await f.db.prepare("SELECT state FROM stores").first()).state,"line_pending");
  await verifyLinePin(f.ctx,actor,f.pin());
  assert.equal((await f.db.prepare("SELECT state FROM stores").first()).state,"line_verified");
});
test("duplicate or concurrent code events never send twice or change the winning LINE destination", async t => {
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);
  const out=await Promise.allSettled([consumeLineCode(f.ctx,event(code)),consumeLineCode(f.ctx,event(code,"other"))]);
  assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(f.pushes.length,1);
  await assert.rejects(()=>consumeLineCode(f.ctx,event(code)));assert.equal(f.pushes.length,1);
  assert.equal((await f.db.prepare("SELECT pending_line_user_id FROM stores").first()).pending_line_user_id,f.pushes[0].to);
});
test("automatic delivery rejects expired or revoked browser sessions and non-private sources", async t => {
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);
  await assert.rejects(()=>consumeLineCode(f.ctx,{...event(code),source:{type:"group",userId:"line-a"}}));
  await f.db.prepare("DELETE FROM sessions").run();
  await assert.rejects(()=>consumeLineCode(f.ctx,event(code)));assert.equal(f.pushes.length,0);
  assert.equal((await f.db.prepare("SELECT pending_line_user_id FROM stores").first()).pending_line_user_id,null);
});
for (const scenario of ["quota-full","quota-unknown","unknown","failed"]) test(`automatic ${scenario} stays unverified with bounded reservations and explicit recovery`,async t=>{
  const f=await setup(t);f.setScenario(scenario);const {code}=await issueLineCode(f.ctx,actor);await consumeLineCode(f.ctx,event(code));
  assert.equal((await f.db.prepare("SELECT state FROM stores").first()).state,"line_pending");
  const delivery=await f.db.prepare("SELECT * FROM line_check_deliveries").first();
  assert.equal(delivery.state,scenario==="unknown"?"uncertain":scenario==="failed"?"failed":"held");
  assert.equal(f.pushes.length,["unknown","failed"].includes(scenario)?1:0);
  if(scenario==="unknown") {
    assert.equal((await f.db.prepare("SELECT state FROM usage_reservations WHERE id=?").bind("line-test:"+delivery.attempt_id).first()).state,"uncertain");
    await verifyLinePin(f.ctx,actor,f.pin());
  } else {
    f.setScenario("ok");f.advance(60001);await sendLineCheck(f.ctx,actor);await verifyLinePin(f.ctx,actor,f.pin());
  }
});
test("a concurrent manual click cannot replace the automatic in-flight PIN or double-dispatch",async t=>{
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);let release,entered;
  const waiting=new Promise(r=>release=r), reached=new Promise(r=>entered=r);
  f.onQuota(async()=>{entered(true);await waiting;});const automatic=consumeLineCode(f.ctx,event(code));assert.equal(await Promise.race([reached,automatic.then(()=>false)]),true);
  await assert.rejects(()=>sendLineCheck(f.ctx,actor),e=>e.code==="LINE_CHECK_BUSY");release();await automatic;
  assert.equal(f.pushes.length,1);await verifyLinePin(f.ctx,actor,f.pin());
});
for(const operation of ["reissue","disconnect"])test(`${operation} during quota reservation cancels automatic dispatch and retains newer state`,async t=>{
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);let fresh;
  f.onQuota(async()=>{if(operation==="reissue")fresh=await issueLineCode(f.ctx,actor);else await disconnectStore(f.ctx,actor);});
  await consumeLineCode(f.ctx,event(code));assert.equal(f.pushes.length,0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM line_check_deliveries").first()).n,0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM line_checks").first()).n,0);
  const row=await f.db.prepare("SELECT state FROM stores").first();if(operation==="reissue")assert.equal(row.state,"line_pending");else assert.equal(row,null);
  if(fresh){f.advance(60001);await consumeLineCode(f.ctx,event(fresh.code,"new-target"));assert.equal(f.pushes[0].to,"new-target");}
});
test("manual recovery keeps rate/daily caps and old PINs fail after reissue or expiry",async t=>{
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);await consumeLineCode(f.ctx,event(code));const old=f.pin();
  await assert.rejects(()=>sendLineCheck(f.ctx,actor),e=>e.code==="RATE_LIMITED");
  for(let i=0;i<2;i++){f.advance(60001);await sendLineCheck(f.ctx,actor);}
  f.advance(60001);await assert.rejects(()=>sendLineCheck(f.ctx,actor),e=>e.code==="RATE_LIMITED");assert.equal(f.pushes.length,3);
  f.advance(300000);await assert.rejects(()=>verifyLinePin(f.ctx,actor,f.pin()),e=>e.code==="PIN_INVALID");
  const fresh=await issueLineCode(f.ctx,actor);await assert.rejects(()=>verifyLinePin(f.ctx,actor,old),e=>e.code==="PIN_INVALID");assert.notEqual(fresh.code,code);assert.equal((await f.db.prepare("SELECT count(*) n FROM line_check_deliveries").first()).n,0);
});

for(const invalid of ["expired","wrong-owner","code-expired"])test(`automatic code is rejected for ${invalid} binding`,async t=>{
  const f=await setup(t);const {code}=await issueLineCode(f.ctx,actor);
  if(invalid==="expired")await f.db.prepare("UPDATE sessions SET expires_at=0").run();
  if(invalid==="wrong-owner")await f.db.prepare("UPDATE sessions SET owner_sub='other'").run();
  if(invalid==="code-expired")f.advance(900000);
  await assert.rejects(()=>consumeLineCode(f.ctx,event(code)),e=>e.code==="LINE_CODE_INVALID");
  assert.equal(f.pushes.length,0);assert.equal((await f.db.prepare("SELECT pending_line_user_id FROM stores").first()).pending_line_user_id,null);
});
test("flag off keeps deliberate manual PIN sending and the old six-column PIN schema",async t=>{
  const f=await setup(t,{SELF_LINE_AUTO_PIN_ENABLED:"false"});const {code}=await issueLineCode(f.ctx,actor);
  await consumeLineCode(f.ctx,event(code));assert.equal(f.pushes.length,0);await sendLineCheck(f.ctx,actor);assert.equal(f.pushes.length,1);
  await f.db.prepare("INSERT OR REPLACE INTO line_checks VALUES (?,?,?,?,?,?)").bind(f.store.id,"test-hash",2,actor.sessionHash,0,400000).run();
  assert.equal((await f.db.prepare("SELECT count(*) n FROM line_check_deliveries").first()).n,1);
  await f.db.prepare("DELETE FROM line_links WHERE store_id=?").bind(f.store.id).run();
  assert.equal((await f.db.prepare("SELECT count(*) n FROM line_check_deliveries").first()).n,0);
});
