import {SelfError,ensure} from './errors.mjs';
export function mapStore(row){if(!row)return null;return {id:row.id,ownerSub:row.owner_sub,accountId:row.account_id,locationId:row.location_id,title:row.title,state:row.state,generation:row.generation,lineUserId:row.line_user_id,lineVerifiedAt:row.line_verified_at,pendingLineUserId:row.pending_line_user_id,updatedAt:row.updated_at,lastPolledAt:row.last_polled_at,lastError:row.last_error};}
export async function findOwnedStore(ctx,sub){return mapStore(await ctx.db.prepare('SELECT * FROM stores WHERE owner_sub=?').bind(sub).first());}
export async function getStore(ctx,id){return mapStore(await ctx.db.prepare('SELECT * FROM stores WHERE id=?').bind(id).first());}
export async function requireStore(ctx,actor){const store=await findOwnedStore(ctx,actor.sub);ensure(store,'STORE_REQUIRED',409);return store;}
export function validateLocation({accountId,locationId}){ensure(/^accounts\/\d+$/.test(accountId)&&/^locations\/\d+$/.test(locationId),'INVALID_LOCATION');}
export async function claimLocation(ctx,{sub,accountId,locationId,title}){
 validateLocation({accountId,locationId});ensure(typeof sub==='string'&&sub.length>0&&sub.length<256,'LOGIN_REQUIRED',401);
 const existing=await findOwnedStore(ctx,sub);
 if(existing){ensure(existing.locationId===locationId&&existing.state!=='disconnected','LOCATION_UNAVAILABLE',409);return existing;}
 const id=crypto.randomUUID();const n=ctx.now();
 try{await ctx.db.batch([
  ctx.db.prepare('INSERT INTO users(sub,created_at) VALUES (?,?) ON CONFLICT DO NOTHING').bind(sub,n),
  ctx.db.prepare('INSERT INTO stores(id,owner_sub,account_id,location_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,sub,accountId,locationId,String(title).slice(0,300),'location_selected',n,n),
  ctx.db.prepare("INSERT INTO location_claims VALUES (?,?,'self')").bind(locationId,id),
 ]);}catch(error){
  const again=await findOwnedStore(ctx,sub);if(again?.locationId===locationId&&again.state!=='disconnected')return again;
  if(/UNIQUE|constraint/i.test(error.message))throw new SelfError('LOCATION_UNAVAILABLE',409);throw error;
 }
 return findOwnedStore(ctx,sub);
}
export async function reserveLegacyLocations(ctx,rows){
 for(const row of rows){ensure(/^locations\/\d+$/.test(row.locationId),'INVALID_LOCATION');
  const existing=await ctx.db.prepare('SELECT * FROM location_claims WHERE location_id=? OR store_id=?').bind(row.locationId,`legacy:${row.storeId}`).first();
  if(existing){ensure(existing.mode==='legacy'&&existing.location_id===row.locationId&&existing.store_id===`legacy:${row.storeId}`,'LOCATION_UNAVAILABLE',409);continue;}
  try{await ctx.db.prepare("INSERT INTO location_claims VALUES (?,?,'legacy')").bind(row.locationId,`legacy:${row.storeId}`).run();}catch{throw new SelfError('LOCATION_UNAVAILABLE',409);}
 }
 return {count:rows.length};
}
