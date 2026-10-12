import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { buildWorker } from "../../scripts/build-self-test.mjs";
import { applySchema, fixtureEnv, seedStore } from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import { createSession } from "../../worker/self-service/session.mjs";
import { issueLineCode } from "../../worker/self-service/line-link.mjs";
import { hmac } from "../../worker/self-service/crypto.mjs";
import { claimLocation } from "../../worker/self-service/store-repository.mjs";

test("signed native webhook sends once in waitUntil, exposes no PIN and still requires original browser", async t => {
  const { SELF_DB, ...bindings } = fixtureEnv(null,{SELF_LINE_AUTO_PIN_ENABLED:"true"});
  const pushes=[], calls=[];
  const mf=new Miniflare({
    modules:true, compatibilityDate:"2024-11-01", scriptPath:fileURLToPath(await buildWorker()),
    bindings,d1Databases:["SELF_DB"],kvNamespaces:["STORES"],
    outboundService:async request=>{
      const url=new URL(request.url);calls.push(url.pathname);
      assert.equal(url.origin,"https://api.line.me");
      assert.equal(request.headers.get("Authorization"),"Bearer fixture-line");
      if(url.pathname.endsWith("/quota"))return Response.json({type:"limited",value:200});
      if(url.pathname.endsWith("/consumption"))return Response.json({totalUsage:0});
      assert.equal(url.pathname,"/v2/bot/message/push");
      pushes.push({body:await request.json(),retryKey:request.headers.get("X-Line-Retry-Key")});
      return Response.json({},{headers:{"x-line-request-id":"native-fixture"}});
    },
  });
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database("SELF_DB");await applySchema(db);
  const ctx=createSelfContext({...bindings,SELF_DB:db});
  await seedStore(ctx,{state:"location_selected",lineUserId:null});
  const browser=await createSession(ctx,"alice"),other=await createSession(ctx,"alice");
  const {code}=await issueLineCode(ctx,{sub:"alice",sessionHash:browser.sessionHash});
  const raw=JSON.stringify({events:[{type:"message",source:{type:"user",userId:"line-a"},message:{type:"text",text:code},webhookEventId:"fixture-native-code"}]});
  const webhook=signature=>mf.dispatchFetch("https://meo.test/webhook/line-bot",{method:"POST",body:raw,headers:{"X-Line-Signature":signature}});
  const invalid=await webhook("invalid-signature");assert.equal(invalid.status,401);assert.equal(pushes.length,0);
  const signature=await hmac(raw,bindings.LINE_CHANNEL_SECRET);
  assert.equal((await webhook(signature)).status,200);
  const status=async s=>(await mf.dispatchFetch("https://meo.test/api/self/status",{headers:{Cookie:s.cookie.split(";")[0]}})).json();
  let state;
  for(let i=0;i<100;i++){
    state=await status(browser);if(state.lineCheck?.state==="sent")break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(state.lineCheck?.state,"sent",JSON.stringify(state.lineCheck));
  assert.equal(state.state,"line_pending");assert.equal(state.lineAutoPin,true);assert.equal(state.lineCheck.pinAvailable,true);
  assert.equal(pushes.length,1);assert.equal(pushes[0].body.to,"line-a");assert.match(pushes[0].retryKey,/^[\da-f-]{36}$/);
  const pin=pushes[0].body.messages[0].text.match(/確認番号: (\d{6})/)[1];
  const projected=JSON.stringify(state.lineCheck);assert.ok(!projected.includes(pin));assert.ok(!projected.includes("line-a"));
  assert.equal((await webhook(signature)).status,200);
  const mismatch=await status(other);assert.equal(mismatch.lineCheck.state,"browser_mismatch");assert.equal(mismatch.lineCheck.pinAvailable,false);
  const verify=async s=>mf.dispatchFetch("https://meo.test/api/self/line/verify",{method:"POST",headers:{Origin:"https://meo.test",Cookie:s.cookie.split(";")[0],"Content-Type":"application/json","X-CSRF-Token":s.csrf},body:JSON.stringify({pin})});
  const denied=await verify(other);assert.equal(denied.status,400);assert.equal((await denied.json()).code,"PIN_INVALID");
  assert.equal((await verify(browser)).status,200);assert.equal((await status(browser)).state,"line_verified");
  assert.equal(pushes.length,1);assert.deepEqual(calls,["/v2/bot/message/quota","/v2/bot/message/quota/consumption","/v2/bot/message/push"]);
});

test("signed multi-code webhook consumes all codes and following legacy action before slow PIN I/O finishes",async t=>{
  const {SELF_DB,...bindings}=fixtureEnv(null,{SELF_LINE_AUTO_PIN_ENABLED:"true"});
  let release;const blocked=new Promise(resolve=>release=resolve);const pushes=[];let quotas=0,replies=0;
  const mf=new Miniflare({modules:true,compatibilityDate:"2024-11-01",scriptPath:fileURLToPath(await buildWorker()),bindings,d1Databases:["SELF_DB"],kvNamespaces:["STORES"],outboundService:async request=>{
    const url=new URL(request.url);assert.equal(url.origin,"https://api.line.me");
    if(url.pathname.endsWith("/reply")){replies++;return Response.json({});}
    if(url.pathname.endsWith("/quota")){quotas++;await blocked;return Response.json({type:"limited",value:200});}
    if(url.pathname.endsWith("/consumption"))return Response.json({totalUsage:0});
    assert.equal(url.pathname,"/v2/bot/message/push");pushes.push(await request.json());return Response.json({});
  }});
  t.after(async()=>{release();await mf.dispose();});
  const db=await mf.getD1Database("SELF_DB");await applySchema(db);const ctx=createSelfContext({...bindings,SELF_DB:db});
  const events=[];
  for(let i=0;i<3;i++){
    const sub="owner-"+i;await claimLocation(ctx,{sub,accountId:"accounts/"+(i+1),locationId:"locations/"+(i+10),title:"架空店"+i});
    const session=await createSession(ctx,sub),code=await issueLineCode(ctx,{sub,sessionHash:session.sessionHash});
    events.push({type:"message",source:{type:"user",userId:"line-"+i},message:{type:"text",text:code.code}});
  }
  const kv=await mf.getKVNamespace("STORES");await kv.put("store:legacy-fixture",JSON.stringify({businessName:"架空旧店舗"}));await kv.put("line-link:MEO-ABCDEF","legacy-fixture");
  events.push({type:"message",source:{type:"user",userId:"legacy-owner"},message:{type:"text",text:"MEO-ABCDEF"},replyToken:"legacy-fixture-reply"});
  const raw=JSON.stringify({events});assert.equal((await mf.dispatchFetch("https://meo.test/webhook/line-bot",{method:"POST",body:raw,headers:{"X-Line-Signature":await hmac(raw,bindings.LINE_CHANNEL_SECRET)}})).status,200);
  let consumed=0;
  for(let i=0;i<100;i++){consumed=(await db.prepare("SELECT count(*) n FROM line_links WHERE consumed_at IS NOT NULL").first()).n;if(consumed===3&&replies===1)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(consumed,3);assert.equal(replies,1);assert.equal(JSON.parse(await kv.get("store:legacy-fixture")).lineUserId,"legacy-owner");assert.equal(pushes.length,0);
  release();let sent=0;
  for(let i=0;i<100;i++){sent=(await db.prepare("SELECT count(*) n FROM line_check_deliveries WHERE state='sent'").first()).n;if(sent===3)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(sent,3);assert.equal(quotas,3);assert.deepEqual(pushes.map(p=>p.to).sort(),["line-0","line-1","line-2"]);
});
