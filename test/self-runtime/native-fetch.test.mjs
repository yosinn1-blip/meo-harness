import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { buildWorker } from "../../scripts/build-self-test.mjs";
import { applySchema, fixtureEnv } from "../support/self-runtime.mjs";

test("real workerd fetch reaches Siteverify, accepts once, and rejects replay and wrong hostname", async (t) => {
  const { SELF_DB, ...bindings } = fixtureEnv(null, {
    SELF_REGISTRATION_ENABLED: "false",
    SELF_PROCESSING_ENABLED: "false",
  });
  const outbound = [];
  const used = new Set();
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: "2024-11-01",
    scriptPath: fileURLToPath(await buildWorker()),
    bindings,
    d1Databases: ["SELF_DB"],
    kvNamespaces: ["STORES"],
    outboundService: async (request) => {
      outbound.push(request.url);
      assert.equal(request.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("secret"), "fixture-turnstile");
      const token = body.get("response");
      if (used.has(token)) return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      used.add(token);
      return Response.json({ success: true, hostname: token === "wrong-host" ? "other.test" : "meo.test", action: "self_start" });
    },
  });
  t.after(() => mf.dispose());
  await applySchema(await mf.getD1Database("SELF_DB"));
  const status = await mf.dispatchFetch("https://meo.test/api/self/status");
  assert.equal(status.status, 200);
  const state = await status.json();
  const start = (challenge) => mf.dispatchFetch("https://meo.test/api/self/google/start", {
    method: "POST",
    headers: { Origin: "https://meo.test", "Content-Type": "application/json", "X-CSRF-Token": state.csrf, Cookie: status.headers.get("set-cookie").split(";")[0] },
    body: JSON.stringify({ intent: "login", challenge }),
  });
  const first = await start("valid-once");
  const result = await first.json();
  assert.equal(first.status, 200, JSON.stringify(result));
  assert.equal(new URL(result.authorizationUrl).searchParams.get("scope"), "openid");
  for (const token of ["valid-once", "wrong-host"]) {
    const rejected = await start(token);
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "CHALLENGE_FAILED");
  }
  assert.equal(outbound.length, 3);
});

test("real workerd pilot endpoints use session owner, not client owner or intent", async (t) => {
  const { pilotSettings } = await import('../support/self-pilot.mjs');
  const { createSelfContext } = await import('../../worker/self-service/config.mjs');
  const { createSession } = await import('../../worker/self-service/session.mjs');
  const { SELF_DB, ...bindings } = fixtureEnv(null, await pilotSettings());
  const outbound=[];
  const mf = new Miniflare({
    modules:true, compatibilityDate:'2024-11-01', scriptPath:fileURLToPath(await buildWorker()), bindings,
    d1Databases:['SELF_DB'], kvNamespaces:['STORES'],
    outboundService: request => {
      outbound.push(request.url);
      assert.equal(request.url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      return Response.json({success:true,hostname:'meo.test',action:'self_start'});
    },
  });
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('SELF_DB'); await applySchema(db);
  const ctx=createSelfContext({...bindings,SELF_DB:db});
  for(const sub of [null,'bob','alice']) {
    if(sub)await db.prepare('INSERT INTO users VALUES (?,?)').bind(sub,Date.now()).run();
    const s=await createSession(ctx,sub);
    const headers={Origin:'https://meo.test','Content-Type':'application/json','X-CSRF-Token':s.csrf,Cookie:s.cookie.split(';')[0]};
    const before=outbound.length;
    const status=await (await mf.dispatchFetch('https://meo.test/api/self/status',{headers})).json();
    assert.equal(status.registrationAllowed,sub==='alice');
    assert.equal(status.registrationOpen,false);
    for(const intent of ['connect', ...(sub?['reconnect']:[])]) {
      const r=await mf.dispatchFetch('https://meo.test/api/self/google/start',{method:'POST',headers,body:JSON.stringify({intent,challenge:'fixture',owner_sub:'alice',pilotOwner:bindings.SELF_PILOT_OWNER_SHA256})});
      assert.equal(r.status,sub==='alice'?200:503);
    }
    if(sub!=='alice') assert.equal(outbound.length,before);
  }
  assert.equal(outbound.length,2);
});
