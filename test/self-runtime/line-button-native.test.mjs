import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {buildWorker} from '../../scripts/build-self-test.mjs';
import {applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode,consumeLineCode} from '../../worker/self-service/line-link.mjs';
import {hmac} from '../../worker/self-service/crypto.mjs';
async function setup(t,enabled=true,through=Infinity){
 const {SELF_DB,...bindings}=fixtureEnv(null,{SELF_LINE_BUTTON_CONFIRM_ENABLED:String(enabled)}),pushes=[];
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',scriptPath:fileURLToPath(await buildWorker()),bindings,d1Databases:['SELF_DB'],kvNamespaces:['STORES'],outboundService:async request=>{
  const u=new URL(request.url);assert.equal(u.origin,'https://api.line.me');
  if(u.pathname.endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(u.pathname.endsWith('/consumption'))return Response.json({totalUsage:0});
  assert.equal(u.pathname,'/v2/bot/message/push');pushes.push(await request.json());return Response.json({});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('SELF_DB');await applySchema(db,{through});
 const ctx=createSelfContext({...bindings,SELF_DB:db});await seedStore(ctx,{state:'location_selected',lineUserId:null});
 const owner=await createSession(ctx,'alice'),other=await createSession(ctx,'alice'),bob=await createSession(ctx,'bob');
 const {code}=await issueLineCode(ctx,{sub:'alice',sessionHash:owner.sessionHash});
 await consumeLineCode(ctx,{type:'message',source:{type:'user',userId:'line-a'},message:{type:'text',text:code}});
 const fetch=(path,init={})=>mf.dispatchFetch('https://meo.test'+path,init);
 const post=(path,body={},session=owner,extra={})=>fetch('/api/self/'+path,{method:'POST',headers:{Origin:'https://meo.test',Cookie:session.cookie.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':session.csrf,...extra},body:JSON.stringify(body)});
 const snapshot=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
 return {mf,db,ctx,pushes,owner,other,bob,fetch,post,snapshot};
}
test('native signature webhook validates raw body and only records receipt; original CSRF POST confirms',async t=>{
 const f=await setup(t);assert.equal((await f.post('line/button')).status,200);assert.equal(f.pushes.length,1);
 const data=f.pushes[0].messages[0].contents.footer.contents[0].action.data;
 const event={type:'postback',source:{type:'user',userId:'line-a'},postback:{data},webhookEventId:'fixture-confirm-event'};
 const raw=JSON.stringify({events:[event]}),sig=await hmac(raw,'fixture-line-secret');
 const webhook=(body,signature)=>f.fetch('/webhook/line-bot',{method:'POST',body,headers:{'X-Line-Signature':signature}});
 const before=await f.snapshot();assert.equal((await webhook(raw,'bad')).status,401);assert.equal((await webhook(raw+' ',sig)).status,401);assert.equal(await f.snapshot(),before);
 const status=async()=> (await f.fetch('/api/self/line/return-status',{headers:{Cookie:f.owner.cookie.split(';')[0]}})).json();
 const forwarded=JSON.stringify({events:[{...event,source:{type:'user',userId:'line-b'}}]});
 assert.equal((await webhook(forwarded,await hmac(forwarded,'fixture-line-secret'))).status,200);
 for(let i=0;i<6;i++){
  assert.equal((await f.db.prepare('SELECT received_at FROM line_button_checks').first()).received_at,null);
  assert.equal((await f.db.prepare('SELECT state FROM stores').first()).state,'line_pending');
  await new Promise(r=>setTimeout(r,10));
 }
 // waitUntil is asynchronous in workerd. Read until the signed receipt appears.
 assert.equal((await webhook(raw,sig)).status,200);let state;
 for(let i=0;i<150;i++){state=await status();if(state.lineCheck?.buttonAvailable)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.lineCheck.buttonAvailable,true);assert.equal(state.lineCheck.pinAvailable,false);assert.equal(state.state,'line_pending');assert(!JSON.stringify(state).includes(data));
 assert.equal((await f.post('line/confirm',{confirmed:true},f.other)).status,400);
 assert.equal((await f.post('line/confirm',{confirmed:true},f.bob)).status,409);
 assert.equal((await f.post('line/confirm',{confirmed:true},f.owner,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await f.post('line/confirm',{confirmed:true},f.owner,{Origin:'https://wrong.test'})).status,403);
 assert.equal((await f.post('line/confirm',{confirmed:false})).status,400);
 assert.equal((await f.post('activate',{confirmed:true,termsVersion:'fixture-v1'})).status,409);
 assert.equal((await f.post('line/confirm',{confirmed:true})).status,200);
 assert.equal((await status()).state,'line_verified');assert.equal((await f.post('activate',{confirmed:false,termsVersion:'fixture-v1'})).status,409);
 assert.equal(f.pushes.length,1);
});
test('native scanner/return and new action GETs are read-only and reveal no account/CSRF to wrong sessions',async t=>{
 const f=await setup(t);await f.post('line/button');const before=await f.snapshot();
 for(const session of [null,f.other,f.bob,f.owner]){
  const headers=session?{Cookie:session.cookie.split(';')[0]}:{};
  for(const path of ['/start?openExternalBrowser=1','/api/self/line/button','/api/self/line/confirm']){
   const r=await f.fetch(path,{headers});assert.equal(r.headers.get('Set-Cookie'),null);
  }
  for(let i=0;i<3;i++){
   const r=await f.fetch('/api/self/line/return-status',{headers});assert.equal(r.headers.get('Set-Cookie'),null);const state=await r.json();
   if(session!==f.owner)assert.deepEqual(state,{ok:true,state:'line_return_mismatch',csrf:null});
  }
 }
 assert.equal(await f.snapshot(),before);assert.equal(f.pushes.length,1);
});
test('native default OFF and migration-through-4 support existing PIN and generic return without new table',async t=>{
 const f=await setup(t,false,4);assert.equal((await f.post('line/button')).status,409);assert.equal((await f.post('line/confirm',{confirmed:true})).status,409);
 assert.equal((await f.post('line/test')).status,200);const pin=f.pushes[0].messages[0].text.match(/確認番号: (\d{6})/)[1];
 assert.equal((await f.post('line/verify',{pin})).status,200);assert.equal((await f.db.prepare('SELECT state FROM stores').first()).state,'line_verified');
 assert.equal((await f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='line_button_checks'").first()).n,0);
});
