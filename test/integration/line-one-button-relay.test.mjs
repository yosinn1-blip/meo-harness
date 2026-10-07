import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {build} from 'esbuild';
import {applySchema,fixtureEnv,seedStore} from '../support/self-runtime.mjs';
import {createSelfContext} from '../../worker/self-service/config.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {issueLineCode} from '../../worker/self-service/line-link.mjs';
import {hmac} from '../../worker/self-service/crypto.mjs';
const meo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const relay=resolve(process.env.MEO_CONFIRM_RELAY_REPO??'/Users/yoshiki/dev/gbp-notify-worker-meo-confirm-20261002');
const secret='fixture-line-secret';
async function setup(t){
 const temp=await mkdtemp(join(tmpdir(),'meo-one-button-native-link-'));
 // Each fixture has its own files. Never overwrite a shared worker.mjs or edit relay sources.
 const relayScript=join(temp,'relay.mjs'),meoScript=join(temp,'meo.mjs');
 await build({entryPoints:[join(relay,'src/index.js')],outfile:relayScript,bundle:true,format:'esm',platform:'neutral',target:'es2022'});
 await build({entryPoints:[join(meo,'worker/index.mjs')],outfile:meoScript,bundle:true,format:'esm',platform:'neutral',target:'es2022',loader:{'.html':'text','.css':'text','.txt':'text','.md':'text','.webp':'binary'}});
 const {SELF_DB,...bindings}=fixtureEnv(null,{SELF_LINE_BUTTON_CONFIRM_ENABLED:'true',SELF_LINE_AUTO_BUTTON_ENABLED:'true',SELF_LINE_ONE_BUTTON_ENABLED:'true',SELF_LINE_AUTO_PIN_ENABLED:'false',LINE_CHANNEL_SECRET:secret});
 const pushes=[],io=[],unexpected=[],errors=[];
 const log=new Log(LogLevel.ERROR);log.logWithLevel=(level,message)=>{if(level<=LogLevel.ERROR)errors.push(String(message));};
 const mf=new Miniflare({log,handleStructuredLogs:entry=>{errors.push(String(entry.message));},workers:[
  {name:'relay',routes:['relay.test/*'],modules:true,compatibilityDate:'2024-01-01',scriptPath:relayScript,modulesRoot:temp,
   bindings:{LINE_CHANNEL_SECRET:secret,LINE_CHANNEL_ACCESS_TOKEN:'fixture-relay',MEO_HARNESS_WEBHOOK_URL:'https://meo.test/webhook/line-bot',MONTHLY_PUSH_LIMIT:'30',HOURLY_PUSH_LIMIT:'12'},
   kvNamespaces:['GBP_NOTIFY_KV'],serviceBindings:{MEO_HARNESS:'meo'},outboundService:request=>{
    const u=new URL(request.url);unexpected.push({worker:'relay',method:request.method,origin:u.origin,path:u.pathname});throw Error('UNEXPECTED_RELAY_EXTERNAL_IO');
   }},
  {name:'meo',routes:['meo.test/*'],modules:true,compatibilityDate:'2024-11-01',scriptPath:meoScript,modulesRoot:temp,bindings,d1Databases:['SELF_DB'],kvNamespaces:['STORES'],outboundService:async request=>{
   const u=new URL(request.url),path=u.pathname;io.push({worker:'meo',method:request.method,origin:u.origin,path});
   if(u.origin!=='https://api.line.me'||!['/v2/bot/message/quota','/v2/bot/message/quota/consumption','/v2/bot/message/push'].includes(path)){
    unexpected.push({worker:'meo',method:request.method,origin:u.origin,path});throw Error('UNEXPECTED_MEO_EXTERNAL_IO');
   }
   assert.equal(request.headers.get('Authorization'),'Bearer fixture-line');
   if(path==='/v2/bot/message/quota'){assert.equal(request.method,'GET');return Response.json({type:'limited',value:200});}
   if(path==='/v2/bot/message/quota/consumption'){assert.equal(request.method,'GET');return Response.json({totalUsage:0});}
   assert.equal(request.method,'POST');assert.match(request.headers.get('X-Line-Retry-Key'),/^[a-f0-9-]{36}$/);
   const body=await request.json();assert.equal(body.to,'line-fixture');assert.equal(body.messages.length,1);assert.equal(body.messages[0].type,'flex');pushes.push(body);return Response.json({});
  }},
 ]});
 // Leave dedicated small bundles under tmp for diagnosis; dispose only this fixture's native runtime.
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('SELF_DB','meo'),relayKV=await mf.getKVNamespace('GBP_NOTIFY_KV','relay'),meoKV=await mf.getKVNamespace('STORES','meo');
 await applySchema(db);await relayKV.put('fixture:marker','relay-only');await meoKV.put('fixture:marker','meo-only');
 const ctx=createSelfContext({...bindings,SELF_DB:db});const store=await seedStore(ctx,{state:'location_selected',lineUserId:null});
 await db.prepare('INSERT INTO users VALUES (?,?)').bind('bob',ctx.now()).run();
 const owner=await createSession(ctx,'alice'),other=await createSession(ctx,'alice'),bob=await createSession(ctx,'bob');
 const {code}=await issueLineCode(ctx,{sub:'alice',sessionHash:owner.sessionHash});
 const event={type:'message',source:{type:'user',userId:'line-fixture'},webhookEventId:'native-one-button-code',message:{type:'text',text:code}};
 const fetch=(url,init={})=>mf.dispatchFetch(url,init);
 const send=async(events=[event],{raw,signature}={})=>{raw??=JSON.stringify({events});signature??=await hmac(raw,secret);return fetch('https://relay.test/webhook/line',{method:'POST',body:raw,headers:{'Content-Type':'application/json','X-Line-Signature':signature}});};
 const status=async(session=owner)=>(await fetch('https://meo.test/api/self/line/return-status',{headers:{Cookie:session.cookie.split(';')[0]}})).json();
 const post=(path,body={},session=owner,extra={})=>fetch('https://meo.test/api/self/'+path,{method:'POST',body:JSON.stringify(body),headers:{Origin:'https://meo.test',Cookie:session.cookie.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':session.csrf,...extra}});
 const start=(uri,session=owner)=>{const url=new URL(uri);url.hash='';return fetch(url.href,{headers:session?{Cookie:session.cookie.split(';')[0]}:{}});};
 const kvSnapshot=async kv=>{const {keys}=await kv.list();return Promise.all(keys.map(k=>k.name).sort().map(async name=>[name,await kv.get(name)]));};
 const snapshot=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify({db:await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])),relayKV:await kvSnapshot(relayKV),meoKV:await kvSnapshot(meoKV)});};
 const wait=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Native two-worker state did not settle');};
 const assertIO=()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(io.map(x=>x.path),['/v2/bot/message/quota','/v2/bot/message/quota/consumption','/v2/bot/message/push']);assert.equal(pushes.length,1);};
 const card=async()=>{
  assert.equal((await send()).status,200);await wait(async()=>pushes.length===1&&(await db.prepare('SELECT state FROM line_check_deliveries').first())?.state==='sent');
  const message=pushes[0].messages[0],actions=message.contents.footer.contents.filter(x=>x.action).map(x=>x.action);assert.equal(actions.length,1);assert.equal(actions[0].type,'uri');assert.equal(actions[0].label,'確認して登録画面へ進む');
  const uri=actions[0].uri,url=new URL(uri),fragment=new URLSearchParams(url.hash.slice(1)),pin=fragment.get('line-confirm');assert.match(pin,/^\d{6}$/);
  assert.equal(url.origin,'https://meo.test');assert.equal(url.pathname,'/start');assert.equal(url.search,'?openExternalBrowser=1');assert.equal(fragment.get('store'),store.id);assert.deepEqual([...fragment.keys()],['line-confirm','store','expires']);
  const current=await status();assert.equal(current.lineOneButton,true);assert.equal(current.lineAutoButton,true);assert.equal(current.lineAutoPin,false);assert.equal(current.lineCheck.method,'pin');assert.equal(current.lineCheck.pinAvailable,true);assert.equal(current.lineCheck.buttonAvailable,false);assert.equal(Number(fragment.get('expires')),current.lineCheck.expiresAt);
  assert.equal((await db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM line_checks').first()).n,1);
  assertIO();return {uri,pin,url};
 };
 return {mf,db,relayKV,meoKV,ctx,store,owner,other,bob,event,fetch,send,status,post,start,snapshot,wait,card,assertIO,pushes,io,unexpected,errors};
}

test('signed standalone MEOS code crosses real relay service binding and native MEO, then only original-owner CSRF PIN POST verifies',async t=>{
 const f=await setup(t),c=await f.card(),before=await f.snapshot();
 const link=await f.db.prepare('SELECT session_hash,consumed_at FROM line_links').first();assert.equal(link.session_hash,f.owner.sessionHash);assert.notEqual(link.consumed_at,null);
 for(let i=0;i<3;i++){
  const status=await f.status(),text=JSON.stringify(status);assert.equal(status.state,'line_pending');assert(!text.includes('"'+c.pin+'"'));assert(!text.includes(c.uri));assert(!text.includes('line-fixture'));assert(!text.includes('pin_hash'));
  assert.equal((await f.start(c.uri)).status,200);
 }assert.equal(await f.snapshot(),before);f.assertIO();
 const noReceipt=await f.post('line/confirm',{confirmed:true});assert.equal(noReceipt.status,400);assert.equal((await noReceipt.json()).code,'LINE_CONFIRMATION_INVALID');assert.equal((await f.post('activate',{confirmed:true,termsVersion:'fixture-v1'})).status,409);
 assert.equal((await f.post('line/verify',{pin:c.pin})).status,200);assert.equal((await f.status()).state,'line_verified');assert.equal((await f.db.prepare('SELECT terms_version FROM stores').first()).terms_version,null);f.assertIO();
});

test('native relay and target reject altered signatures; owner/session/CSRF/Origin and false PIN cannot acquire confirmation',async t=>{
 const f=await setup(t),raw=JSON.stringify({events:[f.event]}),signature=await hmac(raw,secret),before=await f.snapshot();
 for(const bad of [{raw:raw+' ',signature},{raw,signature:'invalid'},{raw,signature:''}])assert.equal((await f.send(undefined,bad)).status,401);
 assert.equal((await f.fetch('https://meo.test/webhook/line-bot',{method:'POST',body:raw+' ',headers:{'X-Line-Signature':signature}})).status,401);assert.equal(await f.snapshot(),before);assert.equal(f.io.length,0);assert.deepEqual(f.unexpected,[]);
 const c=await f.card(),sent=await f.snapshot();
 assert.equal((await f.post('line/verify',{pin:c.pin},f.owner,{'X-CSRF-Token':'bad'})).status,403);assert.equal((await f.post('line/verify',{pin:c.pin},f.owner,{Origin:'https://wrong.test'})).status,403);assert.equal(await f.snapshot(),sent);
 assert.equal((await f.post('line/verify',{pin:c.pin},f.other)).status,400);assert.equal((await f.post('line/verify',{pin:c.pin},f.bob)).status,409);
 assert.deepEqual(await f.status(f.other),{ok:true,state:'line_return_mismatch',csrf:null});assert.equal((await f.db.prepare('SELECT attempts FROM line_checks').first()).attempts,0);
 const wrong=c.pin==='000000'?'000001':'000000',denied=await f.post('line/verify',{pin:wrong});assert.equal(denied.status,400);assert.equal((await denied.json()).code,'PIN_INVALID');assert.equal((await f.db.prepare('SELECT attempts FROM line_checks').first()).attempts,1);
 await f.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').bind(Date.now()-1,f.owner.sessionHash).run();assert.equal((await f.post('line/verify',{pin:c.pin})).status,401);
 assert.equal((await f.db.prepare('SELECT state,terms_version FROM stores').first()).state,'line_pending');assert.equal((await f.db.prepare('SELECT terms_version FROM stores').first()).terms_version,null);f.assertIO();
});

test('URI scanners, GET replays and signed code redelivery never confirm; successful PIN is single-use and never posts to Google',async t=>{
 const f=await setup(t),c=await f.card(),before=await f.snapshot();
 for(let i=0;i<3;i++){
  const scanner=await f.start(c.uri,null);assert.equal(scanner.status,200);assert.equal(scanner.headers.get('Set-Cookie'),null);
  assert.equal((await f.start(c.uri)).headers.get('Set-Cookie'),null);assert.equal((await f.status()).state,'line_pending');
 }assert.equal(await f.snapshot(),before);f.assertIO();
 assert.equal((await f.send()).status,200);await f.wait(()=>f.errors.some(x=>x.includes('LINE_CODE_INVALID')));assert.equal(await f.snapshot(),before);f.assertIO();
 assert.equal((await f.post('line/verify',{pin:c.pin})).status,200);assert.equal((await f.status()).state,'line_verified');assert.equal((await f.post('line/verify',{pin:c.pin})).status,400);
 const verified=await f.snapshot();for(let i=0;i<3;i++){await f.start(c.uri,null);await f.start(c.uri);assert.equal((await f.status()).state,'line_verified');}
 assert.equal(await f.snapshot(),verified);assert.equal((await f.db.prepare('SELECT count(*) n FROM line_button_checks').first()).n,0);assert.equal((await f.db.prepare('SELECT terms_version FROM stores').first()).terms_version,null);f.assertIO();
});
