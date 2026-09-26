import {test} from 'node:test';import assert from 'node:assert/strict';import {withD1,applySchema,fixtureEnv} from '../support/self-runtime.mjs';import {seedGoogleCredential} from '../support/self-google.mjs';import {createSelfContext} from '../../worker/self-service/config.mjs';import {discoverLocations,selectLocation} from '../../worker/self-service/locations.mjs';import {createSession} from '../../worker/self-service/session.mjs';import {getSelfStatus} from '../../worker/self-service/status.mjs';
const actor={sub:'alice'};
function provider({empty=false,fail=false}={}){return async input=>{const u=new URL(input);if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});if(u.pathname==='/v1/accounts')return Response.json({accounts:[{name:'accounts/1'}]});if(u.pathname==='/v1/accounts/1/locations'){if(fail)return Response.json({},{status:500});return Response.json({locations:empty?[]:[{name:'locations/2',title:'架空店'}]});}if(u.pathname==='/v1/locations/2')return Response.json({name:'locations/2',title:'最新の店名'});return Response.json({},{status:404});};}
test('only server-discovered locations can be selected, with permission recheck',async t=>{
 const {db}=await withD1(t);await applySchema(db);const ctx=createSelfContext(fixtureEnv(db),{fetchImpl:provider()});await seedGoogleCredential(ctx);
 await assert.rejects(()=>selectLocation(ctx,actor,{accountId:'accounts/1',locationId:'locations/999'}),e=>e.code==='LOCATION_NOT_ACCESSIBLE');
 const list=await discoverLocations(ctx,actor);assert.equal(list.locations.length,1);assert.equal(await db.prepare('SELECT * FROM stores').first(),null);
 const store=await selectLocation(ctx,actor,{accountId:'accounts/1',locationId:'locations/2'});assert.equal(store.title,'最新の店名');
 await assert.rejects(()=>selectLocation(ctx,{sub:'bob'},{accountId:'accounts/1',locationId:'locations/2'}),e=>e.code==='LOCATION_NOT_ACCESSIBLE');
 const s=await createSession(ctx,'alice');const status=await getSelfStatus(ctx,new Request('https://meo.test/api/self/status',{headers:{Cookie:s.cookie.split(';')[0]}}));assert.equal(status.state,'location_selected');const text=JSON.stringify(status);for(const key of ['fixture-refresh','ciphertext','ownerSub','lineUserId'])assert.ok(!text.includes(key));
});
test('API failure is not zero stores; true empty is normal',async t=>{
 const {db}=await withD1(t);await applySchema(db);const ctx=createSelfContext(fixtureEnv(db),{fetchImpl:provider({empty:true})});await seedGoogleCredential(ctx);assert.deepEqual((await discoverLocations(ctx,actor)).locations,[]);
 ctx.fetchImpl=provider({fail:true});await assert.rejects(()=>discoverLocations(ctx,actor),e=>e.code==='GOOGLE_UNAVAILABLE');
});
test('cursor continues pages and is bound to the authenticated owner',async t=>{
 const {db}=await withD1(t);await applySchema(db);const base=provider();const ctx=createSelfContext(fixtureEnv(db),{fetchImpl:async input=>{const u=new URL(input);if(u.pathname.endsWith('/locations')){const page=Number(u.searchParams.get('pageToken')??0);return Response.json({locations:[{name:'locations/'+(page+2),title:'店'+page}],...(page<2?{nextPageToken:String(page+1)}:{})});}return base(input);}});await seedGoogleCredential(ctx);
 const first=await discoverLocations(ctx,actor);assert.equal(first.locations.length,2);assert.ok(first.nextCursor);
 await assert.rejects(()=>discoverLocations(ctx,{sub:'bob'},{cursor:first.nextCursor}),e=>e.code==='CURSOR_INVALID');
 const next=await discoverLocations(ctx,actor,{cursor:first.nextCursor});assert.equal(next.locations.length,1);assert.equal(next.nextCursor,null);
});
