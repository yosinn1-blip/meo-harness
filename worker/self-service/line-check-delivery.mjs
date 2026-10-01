import { ensure, SelfError } from "./errors.mjs";
import { consumeRate } from "./abuse.mjs";
import { LIMITS, dateKeys } from "./contracts.mjs";
import { hmac } from "./crypto.mjs";
import { reservePush, sendReservedPush, settleUsage } from "./budget.mjs";
const LEASE_MS = 90000;
const eligible = `SELECT 1 FROM stores s JOIN line_links l ON l.store_id=s.id
 JOIN sessions b ON b.token_hash=l.session_hash
 WHERE s.id=? AND s.owner_sub=? AND s.generation=? AND s.pending_line_user_id=?
 AND s.state='line_pending' AND l.session_hash=? AND l.consumed_at IS NOT NULL
 AND b.owner_sub=s.owner_sub AND b.expires_at>?`;
const identity = (store, sessionHash, now) => [store.id, store.ownerSub, store.generation, store.pendingLineUserId, sessionHash, now];
// Only the signed webhook's consumed link or the authenticated browser may call this.
export async function deliverLineCheck(ctx, { store, sessionHash, automatic = false }) {
  const link = await ctx.db.prepare("SELECT session_hash FROM line_links WHERE store_id=?").bind(store.id).first();
  ensure(link?.session_hash === sessionHash, "LINE_BROWSER_MISMATCH", 403);
  const attemptId = crypto.randomUUID(), id = "line-test:" + attemptId;
  const n = ctx.now();
  const claim = await ctx.db.prepare(`INSERT INTO line_check_deliveries
    (store_id,generation,session_hash,attempt_id,state,error_code,expires_at,lease_until,updated_at)
    SELECT ?,?,?,?,'preparing',NULL,0,?,? WHERE EXISTS(${eligible})
    ON CONFLICT(store_id) DO UPDATE SET generation=excluded.generation,session_hash=excluded.session_hash,
    attempt_id=excluded.attempt_id,state='preparing',error_code=NULL,expires_at=0,
    lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE ?=0 AND (line_check_deliveries.state NOT IN ('preparing','sending') OR line_check_deliveries.lease_until<=?)`)
    .bind(store.id,store.generation,sessionHash,attemptId,n+LEASE_MS,n,...identity(store,sessionHash,n),automatic?1:0,n).run();
  if (!claim.meta.changes) {
    const current = await ctx.db.prepare(`SELECT 1 ok WHERE EXISTS(${eligible})`).bind(...identity(store,sessionHash,ctx.now())).first();
    throw new SelfError(current ? "LINE_CHECK_BUSY" : "STORE_CHANGED", 409);
  }
  async function finish(state, errorCode = null) {
    await ctx.db.prepare("UPDATE line_check_deliveries SET state=?,error_code=?,updated_at=? WHERE store_id=? AND attempt_id=?")
      .bind(state,errorCode,ctx.now(),store.id,attemptId).run();
  }
  // A webhook waitUntil has a finite lifetime. Preserve each existing timeout
  // and also cap the combined automatic quota+push I/O at 20 seconds.
  const deadline = automatic ? AbortSignal.timeout(20000) : null;
  const io = deadline ? {...ctx,fetchImpl:(url,init={})=>ctx.fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,deadline]):deadline})} : ctx;
  let reserved = false, dispatched = false;
  try {
    await consumeRate(ctx,{bucket:"test-minute:"+store.id,limit:1,windowMs:60000});
    await consumeRate(ctx,{bucket:"test-day:"+store.id+":"+dateKeys(ctx.now()).day,limit:3,windowMs:86400000});
    const reservation = await reservePush(io,{id,storeId:store.id});
    ensure(reservation.ok,reservation.code,429); reserved = true;
    let random;
    do { random = crypto.getRandomValues(new Uint32Array(1))[0]; } while(random>=4294000000);
    const pin=String(random%1000000).padStart(6,"0"), pinHash=await hmac(pin,ctx.env.SELF_RATE_KEY+":"+store.id);
    const expiresAt=ctx.now()+LIMITS.pinMs;
    const inserted=await ctx.db.batch([
      ctx.db.prepare(`INSERT OR REPLACE INTO line_checks (store_id,pin_hash,generation,session_hash,attempts,expires_at)
        SELECT ?,?,?,?,0,? WHERE EXISTS(${eligible}) AND EXISTS(SELECT 1 FROM line_check_deliveries
        WHERE store_id=? AND attempt_id=? AND state='preparing' AND lease_until>?)`)
        .bind(store.id,pinHash,store.generation,sessionHash,expiresAt,...identity(store,sessionHash,ctx.now()),store.id,attemptId,ctx.now()),
      ctx.db.prepare(`UPDATE line_check_deliveries SET state='sending',expires_at=?,updated_at=?
        WHERE store_id=? AND attempt_id=? AND state='preparing' AND EXISTS(SELECT 1 FROM line_checks
        WHERE store_id=? AND pin_hash=? AND generation=? AND session_hash=? AND expires_at>?)`)
        .bind(expiresAt,ctx.now(),store.id,attemptId,store.id,pinHash,store.generation,sessionHash,ctx.now()),
    ]);
    ensure(inserted.every(r=>r.meta.changes===1),"STORE_CHANGED",409);
    const gate=await ctx.db.prepare(`UPDATE line_check_deliveries SET updated_at=?
      WHERE store_id=? AND attempt_id=? AND state='sending' AND lease_until>? AND EXISTS(${eligible})
      AND EXISTS(SELECT 1 FROM line_checks WHERE store_id=? AND pin_hash=? AND generation=? AND session_hash=? AND expires_at>?)`)
      .bind(ctx.now(),store.id,attemptId,ctx.now(),...identity(store,sessionHash,ctx.now()),store.id,pinHash,store.generation,sessionHash,ctx.now()).run();
    ensure(gate.meta.changes===1,"STORE_CHANGED",409);
    dispatched = true;
    await sendReservedPush(io,{id,to:store.pendingLineUserId,messages:[{type:"text",text:`MEO Harness 確認番号: ${pin}\n5分以内に、登録を始めたブラウザの画面へ戻って入力してください。`}],retryKey:attemptId});
    await finish("sent");
    return {ok:true,expiresAt};
  } catch(error) {
    if (reserved && !dispatched) await settleUsage(ctx,id,"released");
    const code=error instanceof SelfError?error.code:"LINE_RESULT_UNKNOWN";
    const state=dispatched && code==="LINE_RESULT_UNKNOWN"?"uncertain":dispatched?"failed":"held";
    await finish(state,code);
    throw error;
  }
}

// Read-only browser projection. The PIN, hashes and LINE destination stay private.
export async function readLineCheckStatus(ctx, store, sessionHash) {
  if (store.state !== "line_pending" || !store.pendingLineUserId) return null;
  const link=await ctx.db.prepare("SELECT session_hash FROM line_links WHERE store_id=?").bind(store.id).first();
  if (link?.session_hash !== sessionHash)
    return {state:"browser_mismatch",code:"LINE_BROWSER_MISMATCH",pinAvailable:false,expiresAt:null,retryAfterMs:0};
  const delivery=await ctx.db.prepare("SELECT state,error_code,lease_until FROM line_check_deliveries WHERE store_id=? AND generation=? AND session_hash=?")
    .bind(store.id,store.generation,sessionHash).first();
  const pin=await ctx.db.prepare("SELECT expires_at FROM line_checks WHERE store_id=? AND generation=? AND session_hash=? AND expires_at>? AND attempts<5")
    .bind(store.id,store.generation,sessionHash,ctx.now()).first();
  const rate=await ctx.db.prepare("SELECT MAX(expires_at) retry_at FROM rate_limits WHERE (bucket=? AND used>=1 OR bucket=? AND used>=3) AND expires_at>?")
    .bind("test-minute:"+store.id,"test-day:"+store.id+":"+dateKeys(ctx.now()).day,ctx.now()).first();
  const pending=delivery && ["preparing","sending"].includes(delivery.state);
  const interrupted=pending && delivery.lease_until<=ctx.now();
  return {state:interrupted?"uncertain":delivery?.state??"idle",
    code:interrupted?"LINE_RESULT_UNKNOWN":delivery?.error_code??null,
    pinAvailable:Boolean(pin),expiresAt:pin?.expires_at??null,
    retryAfterMs:Math.max(0,(rate?.retry_at??0)-ctx.now(),pending&&!interrupted?delivery.lease_until-ctx.now():0)};
}
