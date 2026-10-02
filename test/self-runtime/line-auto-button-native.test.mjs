import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {buildWorker} from '../../scripts/build-self-test.mjs';
import {applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode} from '../../worker/self-service/line-link.mjs';
import {hmac} from '../../worker/self-service/crypto.mjs';
async function setup(t,{slow=false}={}) {
 const {SELF_DB,...bindings}=fixtureEnv(null,{SELF_LINE_AUTO_BUTTON_ENABLED:'true',SELF_LINE_BUTTON_CONFIRM_ENABLED:'true',SELF_LINE_AUTO_PIN_ENABLED:'true'});
 const pushes=[];let release;const blocked=new Promise(r=>release=r);let replies=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',scriptPath:fileURLToPath(await buildWorker()),bindings,d1Databases:['SELF_DB'],kvNamespaces:['STORES'],outboundService:async request=>{
  const u=new URL(request.url);assert.equal(u.origin,'https://api.line.me');
  if(u.pathname.endsWith('/reply')){replies++;return Response.json({});}
  if(u.pathname.endsWith('/quota')){if(slow)await blocked;return Response.json({type:'limited',value:200});}
  if(u.pathname.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert.equal(u.pathname,'/v2/bot/message/push');assert.equal(request.headers.get('Authorization'),'Bearer fixture-line');
  pushes.push({body:await request.json(),retryKey:request.headers.get('X-Line-Retry-Key')});return Response.json({});
 }});t.after(async()=>{release();await mf.dispose();});const db=await mf.getD1Database('SELF_DB');await applySchema(db);
 const ctx=createSelfContext({...bindings,SELF_DB:db});await seedStore(ctx,{state:'location_selected',lineUserId:null});
 const owner=await createSession(ctx,'alice'),other=await createSession(ctx,'alice');
 const {code}=await issueLineCode(ctx,{sub:'alice',sessionHash:owner.sessionHash});
 const fetch=(path,init={})=>mf.dispatchFetch('https://meo.test'+path,init);
 const rawEvents=events=>JSON.stringify({events});
 const webhook=async(raw,signature)=>fetch('/webhook/line-bot',{method:'POST',body:raw,headers:{'X-Line-Signature':signature??await hmac(raw,bindings.LINE_CHANNEL_SECRET)}});
 const post=(path,body={},session=owner,extra={})=>fetch('/api/self/'+path,{method:'POST',body:JSON.stringify(body),headers:{Origin:'https://meo.test',Cookie:session.cookie.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':session.csrf,...extra}});
 const status=async(session=owner)=>(await fetch('/api/self/line/return-status',{headers:{Cookie:session.cookie.split(';')[0]}})).json();
 const snapshot=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
 const codeEvent={type:'message',source:{type:'user',userId:'line-a'},message:{type:'text',text:code},webhookEventId:'native-auto-button-code'};
 return {mf,db,ctx,pushes,owner,other,fetch,post,status,snapshot,webhook,rawEvents,codeEvent,release,get replies(){return replies;}};
}
async function until(fn,predicate){let value;for(let i=0;i<150;i++){value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,10));}assert.fail('native waitUntil did not complete');}
test('signed native code delivers one Flex; URI alone is read-only; signed receipt plus original CSRF POST are required',async t=>{
 const f=await setup(t),raw=f.rawEvents([f.codeEvent]);const before=await f.snapshot();
 assert.equal((await f.webhook(raw,'bad')).status,401);assert.equal(await f.snapshot(),before);
 assert.equal((await f.webhook(raw)).status,200);let status=await until(()=>f.status(),s=>s.lineCheck?.state==='sent');
 assert.equal(status.lineAutoButton,true);assert.equal(status.lineAutoPin,false);assert.equal(status.lineButtonConfirm,true);
 assert.equal(status.lineCheck.buttonAvailable,false);assert.equal(status.lineCheck.pinAvailable,false);assert.equal(f.pushes.length,1);
 const msg=f.pushes[0].body.messages[0];assert.equal(msg.type,'flex');assert.match(f.pushes[0].retryKey,/^[\da-f-]{36}$/);
 const data=msg.contents.footer.contents[0].action.data;assert(!JSON.stringify(status).includes(data));assert(!JSON.stringify(status).includes('line-a'));
 const sent=await f.snapshot();for(let i=0;i<3;i++){
  assert.equal((await f.fetch('/start?openExternalBrowser=1',{headers:{Cookie:f.owner.cookie.split(';')[0]}})).headers.get('Set-Cookie'),null);
  assert.equal((await f.status()).lineCheck.buttonAvailable,false);
  assert.deepEqual(await f.status(f.other),{ok:true,state:'line_return_mismatch',csrf:null});
 }assert.equal(await f.snapshot(),sent);assert.equal((await f.post('line/confirm',{confirmed:true})).status,409);
 assert.equal((await f.webhook(raw)).status,200);assert.equal(f.pushes.length,1);
 const event={type:'postback',source:{type:'user',userId:'line-a'},postback:{data}};
 assert.equal((await f.webhook(f.rawEvents([event]),'bad')).status,401);
 assert.equal((await f.webhook(f.rawEvents([{...event,source:{type:'user',userId:'line-other'}}]))).status,200);
 for(let i=0;i<5;i++){assert.equal((await f.status()).lineCheck.buttonAvailable,false);await new Promise(r=>setTimeout(r,10));}
 assert.equal((await f.webhook(f.rawEvents([event]))).status,200);status=await until(()=>f.status(),s=>s.lineCheck?.buttonAvailable);
 assert.equal(status.state,'line_pending');assert.equal((await f.post('line/confirm',{confirmed:true},f.other)).status,400);
 assert.equal((await f.post('line/confirm',{confirmed:true},f.owner,{'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await f.post('activate',{confirmed:true,termsVersion:'fixture-v1'})).status,409);
 assert.equal((await f.post('line/confirm',{confirmed:true})).status,200);assert.equal((await f.status()).state,'line_verified');
 assert.equal((await f.db.prepare('SELECT terms_version FROM stores').first()).terms_version,null);assert.equal(f.pushes.length,1);
});
test('native code intake and following legacy event finish before slow automatic Flex delivery',async t=>{
 const f=await setup(t,{slow:true}),kv=await f.mf.getKVNamespace('STORES');
 await kv.put('store:legacy-fixture',JSON.stringify({businessName:'架空旧店舗'}));await kv.put('line-link:MEO-ABCDEF','legacy-fixture');
 const legacy={type:'message',source:{type:'user',userId:'legacy-owner'},message:{type:'text',text:'MEO-ABCDEF'},replyToken:'legacy-reply'};
 assert.equal((await f.webhook(f.rawEvents([f.codeEvent,legacy]))).status,200);
 await until(async()=>({link:await f.db.prepare('SELECT consumed_at FROM line_links').first(),replies:f.replies}),s=>s.link.consumed_at!==null&&s.replies===1);
 assert.equal(f.pushes.length,0);assert.equal(JSON.parse(await kv.get('store:legacy-fixture')).lineUserId,'legacy-owner');
 f.release();await until(()=>f.status(),s=>s.lineCheck?.state==='sent');assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].body.messages[0].type,'flex');
});
