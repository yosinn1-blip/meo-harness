import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';

function setup(t, state) {
  const store = {state, apiKey:'fixture-api', businessName:'架空試験店', gbpAccountId:'accounts/1', gbpLocationId:'locations/2', gbpRefreshToken:'fixture-refresh', lineUserId:'fixture-line', lineChannelToken:'fixture-line-token', utcOffset:9-new Date().getUTCHours()};
  const values = new Map([['store:fixture',JSON.stringify(store)],['pending:fixture',JSON.stringify([{reviewId:'review-1',star:5,text:'よかったです'}])]]);
  const calls = [];
  t.mock.method(globalThis,'fetch',async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    calls.push(u.origin+u.pathname);
    if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture-token'});
    if(u.hostname==='mybusiness.googleapis.com')return Response.json({reviews:[]});
    if(u.hostname==='api.groq.com')return Response.json({choices:[{message:{content:'ご来店ありがとうございました。'}}]});
    if(u.hostname==='api.line.me')return Response.json({});
    throw Error('UNEXPECTED_EXTERNAL_IO');
  });
  return {values,calls,env:{ADMIN_KEY:'fixture-admin',GROQ_API_KEY:'fixture-groq',GBP_OAUTH_CLIENT_ID:'fixture-client',GBP_OAUTH_CLIENT_SECRET:'fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'fixture-line-token',STORES:{
    get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k),
    list:async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))}),
  }}};
}
for(const state of ['paused','disconnected','needs_google_reconnect'])test('legacy scheduler preserves pending data and makes no external calls for '+state, async t=>{
  const {env,values,calls}=setup(t,state), before=values.get('pending:fixture');
  await worker.scheduled({},env,{});
  assert.deepEqual(calls,[]);
  assert.equal(values.get('pending:fixture'),before);
  assert.equal(values.has('gbp-last:fixture'),false);
});
test('paused legacy direct ingestion and explicit test notification are rejected after authentication',async t=>{
  const {env,calls}=setup(t,'paused');
  const review=new Request('https://meo.test/review',{method:'POST',headers:{'X-API-Key':'fixture-api'},body:JSON.stringify({storeId:'fixture',reviews:[{star:5,text:'よかったです'}]})});
  assert.equal((await worker.fetch(review,env,{})).status,409);
  assert.equal((await worker.fetch(new Request('https://meo.test/admin/stores/fixture/notify/test',{method:'POST',headers:{'X-Admin-Key':'fixture-admin'}}),env,{})).status,409);
  assert.deepEqual(calls,[]);
});
for(const state of [undefined,'active'])test('legacy active compatibility retains normal scheduling: '+String(state),async t=>{
  const {env,values,calls}=setup(t,state);
  await worker.scheduled({},env,{});
  assert(calls.some(x=>x.startsWith('https://api.line.me/')));
  assert(calls.some(x=>x.startsWith('https://mybusiness.googleapis.com/')));
  assert.equal(values.has('pending:fixture'),false);
});
