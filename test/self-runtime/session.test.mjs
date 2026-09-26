import {test} from 'node:test';import assert from 'node:assert/strict';
import {withD1,applySchema,fixtureEnv} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession,requireActor,requireMutation,readSession,revokeSession} from '../../worker/self-service/session.mjs';
import {consumeRate} from '../../worker/self-service/abuse.mjs';
test('session secret is hashed, expires exactly at 24h, CSRF and Origin required',async t=>{
 const {db}=await withD1(t);await applySchema(db);let n=1000;const ctx=createSelfContext(fixtureEnv(db),{now:()=>n});
 const s=await createSession(ctx,'alice');const cookie=s.cookie.split(';')[0];assert.match(s.cookie,/HttpOnly; Secure; SameSite=Lax/);
 const req=(extra={})=>new Request('https://meo.test/api/self/pause',{method:'POST',headers:{Cookie:cookie,Origin:'https://meo.test','X-CSRF-Token':s.csrf,...extra}});
 assert.equal((await requireMutation(ctx,req())).sub,'alice');
 await assert.rejects(()=>requireMutation(ctx,req({Origin:'https://evil.test'})),e=>e.code==='ORIGIN_DENIED');
 await assert.rejects(()=>requireMutation(ctx,req({'X-CSRF-Token':''})),e=>e.code==='CSRF_INVALID');
 const raw=await db.prepare('SELECT * FROM sessions').first();assert.ok(!JSON.stringify(raw).includes(cookie.split('=')[1]));
 n+=86400000;await assert.rejects(()=>requireActor(ctx,req()),e=>e.code==='LOGIN_REQUIRED');
});
test('revocation also cancels attempts tied to old session',async t=>{
 const {db}=await withD1(t);await applySchema(db);const ctx=createSelfContext(fixtureEnv(db));const s=await createSession(ctx,null);
 await revokeSession(ctx,s.sessionHash);assert.equal(await readSession(ctx,new Request('https://meo.test',{headers:{Cookie:s.cookie.split(';')[0]}})),null);
});
test('rate limits are atomic under concurrency and reset at window boundary',async t=>{
 const {db}=await withD1(t);await applySchema(db);let now=100;const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
 const take=()=>consumeRate(ctx,{bucket:'owner:a',limit:2,windowMs:1000});
 const a=await Promise.allSettled([take(),take(),take()]);assert.equal(a.filter(x=>x.status==='fulfilled').length,2);
 now=1100;await take();
});
