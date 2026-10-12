import { ensure, SelfError } from "./errors.mjs";
import { consumeRate } from "./abuse.mjs";
import { LIMITS, dateKeys } from "./contracts.mjs";
import { hmac, sha256, safeEqual } from "./crypto.mjs";
import { readSelfConfig } from "./config.mjs";
import { reservePush, sendReservedPush, settleUsage } from "./budget.mjs";
import { linkConfirmationMessage } from "./line-confirm-link.mjs";
import { DELIVERY_ELIGIBLE as eligible, deliveryIdentity as identity, newButtonChallenge, buttonMessage,
  BUTTON_PURPOSE, readButtonCheck, requireButtonMode } from "./line-button-confirm.mjs";
const LEASE_MS = 90000;
// Only a dedicated, explicit owner opt-in bypasses the daily bucket. The store
// is the authenticated DB model; request body/query/header owner values are not used.
async function dailyLineCheckLimit(ctx, store) {
  const ownerHash = ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256;
  if (ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED !== "true" ||
      typeof ownerHash !== "string" || !/^[a-f0-9]{64}$/.test(ownerHash) ||
      typeof store.ownerSub !== "string" || !store.ownerSub || readSelfConfig(ctx.env).pilotMode)
    return 3;
  return safeEqual(await sha256(store.ownerSub), ownerHash) ? null : 3;
}
// Only the signed webhook's consumed link or the authenticated browser may call this.
export async function deliverLineCheck(ctx, { store, sessionHash, automatic = false, method = "pin" }) {
  ensure(["pin","button","link"].includes(method),"LINE_CONFIRMATION_INVALID");
  const button = method === "button", linkMode = method === "link";
  // Only the opted-in manual PIN fallback shares the new card binding window.
  // Legacy autoPIN and unset/OFF legacy PIN delivery retain their prior behavior.
  const keepPinBinding = linkMode || (!automatic && !button && readSelfConfig(ctx.env).lineOneButton);
  function checkButtonMode() {
    if (!button && !linkMode) return;
    requireButtonMode(ctx);
    const config = readSelfConfig(ctx.env);
    ensure(!linkMode || config.lineOneButton,"LINE_BUTTON_DISABLED",409);
    ensure(!automatic || config.autoLineButton,"LINE_BUTTON_DISABLED",409);
  }
  checkButtonMode();
  const link = await ctx.db.prepare("SELECT session_hash FROM line_links WHERE store_id=?").bind(store.id).first();
  ensure(link?.session_hash === sessionHash, "LINE_BROWSER_MISMATCH", 403);
  const attemptId = crypto.randomUUID(), id = "line-test:" + attemptId;
  const n = ctx.now();
  const challenge = button ? await newButtonChallenge(ctx) : null;
  const claimStatement = ctx.db.prepare(`INSERT INTO line_check_deliveries
    (store_id,generation,session_hash,attempt_id,state,error_code,expires_at,lease_until,updated_at)
    SELECT ?,?,?,?,'preparing',NULL,0,?,? WHERE EXISTS(${eligible})
    ON CONFLICT(store_id) DO UPDATE SET generation=excluded.generation,session_hash=excluded.session_hash,
    attempt_id=excluded.attempt_id,state='preparing',error_code=NULL,expires_at=0,
    lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE ?=0 AND (line_check_deliveries.state NOT IN ('preparing','sending') OR line_check_deliveries.lease_until<=?)`)
    .bind(store.id,store.generation,sessionHash,attemptId,n+LEASE_MS,n,...identity(store,sessionHash,n),automatic?1:0,n);
  checkButtonMode();
  let claim;
  if (button || linkMode) {
    try {
      const claimed = await ctx.db.batch([
        claimStatement,
        ctx.db.prepare("INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM line_check_deliveries WHERE store_id=? AND attempt_id=? AND state='preparing')").bind(store.id,attemptId),
        ctx.db.prepare("DELETE FROM line_checks WHERE store_id=?").bind(store.id),
        // The code is already consumed. Keep its binding alive for the new card's
        // entire five-minute window, without extending any unused code validity.
        ctx.db.prepare("UPDATE line_links SET expires_at=MAX(expires_at,?) WHERE store_id=? AND session_hash=? AND consumed_at IS NOT NULL")
          .bind(button?challenge.expiresAt:n+LIMITS.pinMs,store.id,sessionHash),
        ...(button?[ctx.db.prepare("INSERT OR REPLACE INTO line_button_checks(store_id,owner_sub,generation,session_hash,line_user_id,attempt_id,purpose,nonce_hash,expires_at,received_at,consumed_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)")
          .bind(store.id,store.ownerSub,store.generation,sessionHash,store.pendingLineUserId,attemptId,BUTTON_PURPOSE,challenge.hash,challenge.expiresAt)]:[]),
        ctx.db.prepare("DELETE FROM mutation_guards"),
      ]);
      claim=claimed[0];
    } catch(error) {
      if (!/CHECK constraint failed/i.test(error.message)) throw error;
      const current=await ctx.db.prepare(`SELECT 1 ok WHERE EXISTS(${eligible})`).bind(...identity(store,sessionHash,ctx.now())).first();
      throw new SelfError(current?"LINE_CHECK_BUSY":"STORE_CHANGED",409);
    }
  } else claim=await claimStatement.run();
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
  const deadline = automatic ? AbortSignal.any([AbortSignal.timeout(20000),...(ctx.lineCheckSignal?[ctx.lineCheckSignal]:[])]) : null;
  const io = deadline ? {...ctx,fetchImpl:(url,init={})=>ctx.fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,deadline]):deadline})} : ctx;
  let reserved = false, dispatched = false;
  try {
    ensure(!deadline?.aborted,"LINE_RETRY_REQUIRED",429);
    checkButtonMode();
    await consumeRate(ctx,{bucket:"test-minute:"+store.id,limit:1,windowMs:60000});
    const dailySendLimit = await dailyLineCheckLimit(ctx,store);
    if (dailySendLimit !== null)
      await consumeRate(ctx,{bucket:"test-day:"+store.id+":"+dateKeys(ctx.now()).day,limit:dailySendLimit,windowMs:86400000});
    const reservation = await reservePush(io,{id,storeId:store.id});
    ensure(reservation.ok,reservation.code,429); reserved = true;
    ensure(!deadline?.aborted,"LINE_RETRY_REQUIRED",429);
    if (linkMode) checkButtonMode();
    let pin, pinHash;
    if (!button) {
      let random;
      do { random = crypto.getRandomValues(new Uint32Array(1))[0]; } while(random>=4294000000);
      pin=String(random%1000000).padStart(6,"0");
      pinHash=await hmac(pin,ctx.env.SELF_RATE_KEY+":"+store.id);
    }
    const expiresAt=button?challenge.expiresAt:ctx.now()+LIMITS.pinMs;
    const readyStatements=button ? [
      ctx.db.prepare(`UPDATE line_check_deliveries SET state='sending',expires_at=?,updated_at=?
        WHERE store_id=? AND attempt_id=? AND state='preparing' AND lease_until>? AND EXISTS(${eligible})
        AND EXISTS(SELECT 1 FROM line_button_checks WHERE store_id=? AND attempt_id=? AND nonce_hash=? AND expires_at>?)`)
        .bind(expiresAt,ctx.now(),store.id,attemptId,ctx.now(),...identity(store,sessionHash,ctx.now()),store.id,attemptId,challenge.hash,ctx.now()),
    ] : [
      ...(keepPinBinding?[
        ctx.db.prepare(`UPDATE line_links SET expires_at=MAX(expires_at,?)
          WHERE store_id=? AND session_hash=? AND consumed_at IS NOT NULL AND EXISTS(${eligible})`)
          .bind(expiresAt,store.id,sessionHash,...identity(store,sessionHash,ctx.now())),
      ]:[]),
      ctx.db.prepare(`INSERT OR REPLACE INTO line_checks (store_id,pin_hash,generation,session_hash,attempts,expires_at)
        SELECT ?,?,?,?,0,? WHERE EXISTS(${eligible}) AND EXISTS(SELECT 1 FROM line_check_deliveries
        WHERE store_id=? AND attempt_id=? AND state='preparing' AND lease_until>?)`)
        .bind(store.id,pinHash,store.generation,sessionHash,expiresAt,...identity(store,sessionHash,ctx.now()),store.id,attemptId,ctx.now()),
      ctx.db.prepare(`UPDATE line_check_deliveries SET state='sending',expires_at=?,updated_at=?
        WHERE store_id=? AND attempt_id=? AND state='preparing' AND EXISTS(SELECT 1 FROM line_checks
        WHERE store_id=? AND pin_hash=? AND generation=? AND session_hash=? AND expires_at>?)`)
        .bind(expiresAt,ctx.now(),store.id,attemptId,store.id,pinHash,store.generation,sessionHash,ctx.now()),
    ];
    const inserted=await ctx.db.batch(readyStatements);
    ensure(inserted.every(r=>r.meta.changes===1),"STORE_CHANGED",409);
    const gate=await ctx.db.prepare(`UPDATE line_check_deliveries SET updated_at=?
      WHERE store_id=? AND attempt_id=? AND state='sending' AND lease_until>? AND EXISTS(${eligible})
      AND ${button?"EXISTS(SELECT 1 FROM line_button_checks WHERE store_id=? AND attempt_id=? AND nonce_hash=? AND expires_at>?)":"EXISTS(SELECT 1 FROM line_checks WHERE store_id=? AND pin_hash=? AND generation=? AND session_hash=? AND expires_at>?)"}`)
      .bind(ctx.now(),store.id,attemptId,ctx.now(),...identity(store,sessionHash,ctx.now()),
        ...(button?[store.id,attemptId,challenge.hash,ctx.now()]:[store.id,pinHash,store.generation,sessionHash,ctx.now()])).run();
    ensure(gate.meta.changes===1,"STORE_CHANGED",409);
    ensure(!deadline?.aborted,"LINE_RETRY_REQUIRED",429);
    checkButtonMode();
    dispatched = true;
    await sendReservedPush(io,{id,to:store.pendingLineUserId,messages:[button?buttonMessage(ctx,store,challenge.nonce):linkMode?linkConfirmationMessage(ctx,store,pin,expiresAt):{type:"text",text:`MEO Harness 確認番号: ${pin}\n5分以内に、登録を始めたブラウザの画面へ戻って入力してください。`}],retryKey:attemptId});
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
  const link=await ctx.db.prepare("SELECT session_hash,consumed_at FROM line_links WHERE store_id=?").bind(store.id).first();
  if (link && link.session_hash !== sessionHash)
    return {state:"browser_mismatch",code:"LINE_BROWSER_MISMATCH",pinAvailable:false,expiresAt:null,retryAfterMs:0};
  const dailySendLimit=await dailyLineCheckLimit(ctx,store);
  const n=ctx.now(),minuteBucket="test-minute:"+store.id,dayBucket="test-day:"+store.id+":"+dateKeys(n).day;
  const rate=await ctx.db.prepare(`SELECT
    MAX(CASE WHEN bucket=? THEN expires_at END) minute_at,
    MAX(CASE WHEN bucket=? THEN expires_at END) day_at
    FROM rate_limits WHERE (bucket=? AND used>=1 OR bucket=? AND used>=3) AND expires_at>?`)
    .bind(minuteBucket,dayBucket,minuteBucket,dayBucket,n).first();
  // The daily bucket changes at JST midnight even when its 24-hour row lives on.
  const tomorrowJST=(Math.floor((n+9*3600000)/86400000)+1)*86400000-9*3600000;
  const dayUntil=dailySendLimit!==null && rate.day_at?Math.min(rate.day_at,tomorrowJST):0;
  const rateWait=Math.max(0,(rate.minute_at??0)-n,dayUntil-n);
  const sendLimit=dayUntil?{kind:"daily",retryAt:dayUntil}
    :rate.minute_at?{kind:"minute",retryAt:rate.minute_at}:null;
  // Keep legacy unset projections compatible. UI defaults missing dailySendLimit
  // to three; only a verified, explicitly enabled owner ever receives null.
  const rateProjection={
    ...(readSelfConfig(ctx.env).lineButtonConfirm?{sendLimit}:{}),
    ...(ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED!==undefined ||
        ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256!==undefined?{dailySendLimit}:{}),
  };
  if (!link)
    return {state:"link_missing",code:"LINE_LINK_MISSING",pinAvailable:false,expiresAt:null,retryAfterMs:rateWait,...rateProjection};
  const delivery=await ctx.db.prepare("SELECT attempt_id,state,error_code,lease_until FROM line_check_deliveries WHERE store_id=? AND generation=? AND session_hash=?")
    .bind(store.id,store.generation,sessionHash).first();
  const pin=await ctx.db.prepare("SELECT expires_at FROM line_checks WHERE store_id=? AND generation=? AND session_hash=? AND expires_at>? AND attempts<5")
    .bind(store.id,store.generation,sessionHash,ctx.now()).first();
  const pending=delivery && ["preparing","sending"].includes(delivery.state);
  const interrupted=pending && delivery.lease_until<=ctx.now();
  // A lost waitUntil task must become explicit recovery, never perpetual waiting.
  const autoStarting = !delivery && readSelfConfig(ctx.env).autoLineButton && link.consumed_at !== null;
  const startUntil = autoStarting ? link.consumed_at + 20000 : 0;
  const awaiting = autoStarting && startUntil > ctx.now();
  const buttonCheck=await readButtonCheck(ctx,store,sessionHash,delivery);
  return {state:interrupted?"uncertain":delivery?.state??(awaiting?"awaiting":autoStarting?"held":"idle"),
    code:interrupted?"LINE_RESULT_UNKNOWN":delivery?.error_code??(autoStarting&&!awaiting?"LINE_RETRY_REQUIRED":null),
    pinAvailable:Boolean(pin),expiresAt:pin?.expires_at??null,
    retryAfterMs:Math.max(rateWait,pending&&!interrupted?delivery.lease_until-ctx.now():0,awaiting?startUntil-ctx.now():0),
    ...rateProjection,
    ...(buttonCheck??{})};
}
