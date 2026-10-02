import { readSelfConfig } from "./config.mjs";
import { LIMITS, dateKeys } from "./contracts.mjs";
import { ensure, SelfError } from "./errors.mjs";
import { sha256, hmac, safeEqual } from "./crypto.mjs";
import { getStore, requireStore } from "./store-repository.mjs";
import { consumeRate } from "./abuse.mjs";
import { deliverLineCheck } from "./line-check-delivery.mjs";
import { requireButtonMode } from "./line-button-confirm.mjs";
export function authorizeLineActor({ source, registeredUserId, active }) {
  return Boolean(
    active &&
      registeredUserId &&
      source?.type === "user" &&
      source.userId === registeredUserId,
  );
}
export async function issueLineCode(ctx, actor) {
  ensure(!readSelfConfig(ctx.env).pilotMode, "PROCESSING_CLOSED", 503);
  const s = await requireStore(ctx, actor);
  ensure(s.state !== "disconnected", "STORE_INACTIVE", 409);
  await consumeRate(ctx, {
    bucket: "link:" + actor.sub,
    limit: 5,
    windowMs: 600000,
  });
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code =
    "MEOS-" +
    Array.from(
      crypto.getRandomValues(new Uint8Array(12)),
      (x) => chars[x & 31],
    ).join("");
  const expiresAt = ctx.now() + LIMITS.linkMs;
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM line_checks WHERE store_id=?").bind(s.id),
    ctx.db
      .prepare(
        "INSERT OR REPLACE INTO line_links(code_hash,store_id,session_hash,expires_at,consumed_at) VALUES (?,?,?,?,NULL)",
      )
      .bind(await sha256(code), s.id, actor.sessionHash, expiresAt),
    ctx.db
      .prepare(
        "UPDATE stores SET state='line_pending',generation=generation+1,pending_line_user_id=NULL,line_verified_at=NULL,updated_at=? WHERE id=? AND state<>'disconnected'",
      )
      .bind(ctx.now(), s.id),
  ]);
  return { code, expiresAt, addFriendUrl: ctx.env.SELF_LINE_FRIEND_URL };
}
export async function consumeLineCode(ctx, event, { deferCheck } = {}) {
  if (readSelfConfig(ctx.env).pilotMode) return;
  ensure(
    event.source?.type === "user" && typeof event.source.userId === "string" && event.source.userId.length > 0 && event.source.userId.length <= 256,
    "LINE_USER_REQUIRED",
  );
  const code = event.message?.text?.trim().toUpperCase();
  ensure(/^MEOS-[A-HJ-NP-Z2-9]{12}$/.test(code), "LINE_CODE_INVALID");
  const hash = await sha256(code), now = ctx.now();
  const config = readSelfConfig(ctx.env);
  const automatic = config.autoLinePin || config.autoLineButton;
  const method = config.autoLineButton ? (config.lineOneButton ? "link" : "button") : "pin";
  if (automatic) ensure(event.type === "message" && event.message?.type === "text", "LINE_CODE_INVALID");
  const liveSession = automatic
    ? " AND EXISTS(SELECT 1 FROM sessions b WHERE b.token_hash=l.session_hash AND b.owner_sub=s.owner_sub AND b.expires_at>?)"
    : "";
  const snapshot = await ctx.db.prepare(`SELECT l.*,s.owner_sub,s.generation FROM line_links l JOIN stores s ON s.id=l.store_id
    WHERE l.code_hash=? AND l.expires_at>? AND l.consumed_at IS NULL AND s.state='line_pending'${liveSession}`)
    .bind(hash,now,...(automatic?[now]:[])).first();
  ensure(snapshot,"LINE_CODE_INVALID");
  const consumedNow = ctx.now();
  const updates = [
    ctx.db.prepare("UPDATE stores SET pending_line_user_id=?,updated_at=? WHERE id=? AND state='line_pending' AND generation=? AND EXISTS(SELECT 1 FROM line_links WHERE store_id=? AND code_hash=? AND expires_at>? AND consumed_at IS NULL)")
      .bind(event.source.userId,consumedNow,snapshot.store_id,snapshot.generation,snapshot.store_id,hash,consumedNow),
    ctx.db.prepare("UPDATE line_links SET consumed_at=? WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL AND EXISTS(SELECT 1 FROM stores WHERE id=? AND generation=? AND state='line_pending' AND pending_line_user_id=?)")
      .bind(consumedNow,hash,consumedNow,snapshot.store_id,snapshot.generation,event.source.userId),
  ];
  let result;
  try {
    result = await ctx.db.batch(automatic ? [
      // Recheck the original live browser inside the atomic write. A logout,
      // owner change or reissue after the snapshot must consume nothing.
      ctx.db.prepare(`INSERT INTO mutation_guards SELECT EXISTS(
        SELECT 1 FROM line_links l JOIN stores s ON s.id=l.store_id
        JOIN sessions b ON b.token_hash=l.session_hash
        WHERE l.code_hash=? AND l.store_id=? AND l.session_hash=?
        AND l.expires_at>? AND l.consumed_at IS NULL AND s.state='line_pending'
        AND s.owner_sub=? AND s.generation=? AND b.owner_sub=s.owner_sub AND b.expires_at>?)`)
        .bind(hash,snapshot.store_id,snapshot.session_hash,consumedNow,snapshot.owner_sub,snapshot.generation,consumedNow),
      ...updates,
      ctx.db.prepare("DELETE FROM mutation_guards"),
    ] : updates);
  } catch (error) {
    if (/CHECK constraint failed/i.test(error.message)) throw new SelfError("LINE_CODE_INVALID",400);
    throw error;
  }
  ensure(result.every(r=>r.meta.changes===1),"LINE_CODE_INVALID");
  if(automatic) {
    const deliver = async () => {
      try {
        const store=await getStore(ctx,snapshot.store_id);
        ensure(store?.generation===snapshot.generation && store.pendingLineUserId===event.source.userId,"STORE_CHANGED",409);
        await deliverLineCheck(ctx,{store,sessionHash:snapshot.session_hash,automatic:true,method});
        return {ok:true};
      } catch(error) {
        // Link consumption remains valid. Read-only status and explicit browser
        // recovery handle quota holds, failures, unknown sends and interruptions.
        return {ok:true,checkCode:error instanceof SelfError?error.code:"LINE_RESULT_UNKNOWN"};
      }
    };
    // The webhook supervisor consumes the whole ordered event batch before
    // waiting on slow automatic delivery. Direct callers keep awaited behavior.
    if (deferCheck) deferCheck(deliver);
    else return deliver();
  }
  return {ok:true};
}
export async function sendLineCheck(ctx, actor) {
  ensure(!readSelfConfig(ctx.env).pilotMode,"PROCESSING_CLOSED",503);
  const store=await requireStore(ctx,actor);
  ensure(store.state==="line_pending" && store.pendingLineUserId,"LINE_PENDING_REQUIRED",409);
  return deliverLineCheck(ctx,{store,sessionHash:actor.sessionHash});
}
export async function sendLineButton(ctx, actor) {
  requireButtonMode(ctx);
  const store=await requireStore(ctx,actor);
  ensure(store.state==="line_pending" && store.pendingLineUserId,"LINE_PENDING_REQUIRED",409);
  return deliverLineCheck(ctx,{store,sessionHash:actor.sessionHash,method:readSelfConfig(ctx.env).lineOneButton?"link":"button"});
}
export async function verifyLinePin(ctx, actor, pin) {
  ensure(!readSelfConfig(ctx.env).pilotMode, "PROCESSING_CLOSED", 503);
  ensure(/^\d{6}$/.test(pin), "PIN_INVALID");
  const s = await requireStore(ctx, actor);
  const n = ctx.now();
  const record = await ctx.db
    .prepare(
      "UPDATE line_checks SET attempts=attempts+1 WHERE store_id=? AND session_hash=? AND generation=? AND expires_at>? AND attempts<5 RETURNING *",
    )
    .bind(s.id, actor.sessionHash, s.generation, n)
    .first();
  ensure(
    record &&
      safeEqual(
        record.pin_hash,
        await hmac(pin, ctx.env.SELF_RATE_KEY + ":" + s.id),
      ),
    "PIN_INVALID",
  );
  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE stores SET line_user_id=pending_line_user_id,pending_line_user_id=NULL,line_verified_at=?,state='line_verified',updated_at=? WHERE id=? AND state='line_pending' AND generation=? AND pending_line_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM line_checks WHERE store_id=? AND pin_hash=? AND session_hash=? AND expires_at>? AND attempts<=5)",
      )
      .bind(
        n,
        n,
        s.id,
        s.generation,
        s.id,
        record.pin_hash,
        actor.sessionHash,
        n,
      ),
    ctx.db
      .prepare(
        "DELETE FROM line_checks WHERE store_id=? AND pin_hash=? AND session_hash=?",
      )
      .bind(s.id, record.pin_hash, actor.sessionHash),
  ]);
  ensure(results[0].meta.changes === 1, "PIN_INVALID");
  return { ok: true };
}
