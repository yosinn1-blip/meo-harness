import { readSelfConfig } from "./config.mjs";
import { randomToken, sha256 } from "./crypto.mjs";
import { LIMITS } from "./contracts.mjs";
import { ensure, SelfError } from "./errors.mjs";
import { requireStore } from "./store-repository.mjs";
export const BUTTON_PURPOSE = "confirm_line_destination_v1";
export const DELIVERY_ELIGIBLE = `SELECT 1 FROM stores s JOIN line_links l ON l.store_id=s.id
 JOIN sessions b ON b.token_hash=l.session_hash
 WHERE s.id=? AND s.owner_sub=? AND s.generation=? AND s.pending_line_user_id=?
 AND s.state='line_pending' AND l.session_hash=? AND l.consumed_at IS NOT NULL
 AND b.owner_sub=s.owner_sub AND b.expires_at>?`;
export const deliveryIdentity = (s, sessionHash, now) => [s.id, s.ownerSub, s.generation, s.pendingLineUserId, sessionHash, now];
const bound = `SELECT 1 FROM line_button_checks c JOIN stores s ON s.id=c.store_id
 JOIN line_links l ON l.store_id=s.id JOIN sessions b ON b.token_hash=c.session_hash
 JOIN line_check_deliveries d ON d.store_id=c.store_id AND d.attempt_id=c.attempt_id
 WHERE c.store_id=? AND c.nonce_hash=? AND c.purpose=? AND c.owner_sub=s.owner_sub
 AND c.generation=s.generation AND c.session_hash=l.session_hash AND b.owner_sub=s.owner_sub
 AND c.line_user_id=s.pending_line_user_id AND s.state='line_pending' AND l.consumed_at IS NOT NULL
 AND d.generation=c.generation AND d.session_hash=c.session_hash
 AND d.state IN ('sending','sent','uncertain') AND c.expires_at>? AND b.expires_at>?
 AND c.consumed_at IS NULL`;
const binding = (record, now) => [record.store_id, record.nonce_hash, BUTTON_PURPOSE, now, now];
export function requireButtonMode(ctx) {
  ensure(readSelfConfig(ctx.env).lineButtonConfirm, "LINE_BUTTON_DISABLED", 409);
}
export async function newButtonChallenge(ctx) {
  requireButtonMode(ctx);
  const nonce = randomToken(32);
  return { nonce, hash: await sha256(BUTTON_PURPOSE + ":" + nonce), expiresAt: ctx.now() + LIMITS.pinMs };
}
export function buttonMessage(ctx, store, nonce) {
  const uri = readSelfConfig(ctx.env).origin + "/start?openExternalBrowser=1";
  return { type: "flex", altText: "MEO Harness：LINEで確認して登録を続ける", contents: {
    type: "bubble", body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "通知先のLINEを確認", weight: "bold", wrap: true },
      { type: "text", text: store.title.slice(0,300), wrap: true },
      { type: "text", text: "ご自身で始めたMEO Harnessの登録だけ確認してください。心当たりがなければ押さないでください。", wrap: true },
    ]}, footer: { type: "box", layout: "vertical", contents: [
      { type: "button", action: { type: "postback", label: "このLINEで確認", data: "meo-confirm:v1:" + nonce } },
      { type: "button", action: { type: "uri", label: "登録を続ける", uri } },
      { type: "text", text: "先に確認を押し、登録を続けるで元のブラウザへ。5分以内に、元の登録画面で通知先を確定してください。", size: "sm", wrap: true },
    ]},
  }};
}
// Called only from the raw-body signature-verified LINE webhook dispatch.
// Receipt is separate from delivery.state: a late send result cannot erase it.
export async function receiveLineButton(ctx, event) {
  requireButtonMode(ctx);
  const match = /^meo-confirm:v1:([A-Za-z0-9_-]{43})$/.exec(event.postback?.data ?? "");
  ensure(event.type === "postback" && event.source?.type === "user" &&
    typeof event.source.userId === "string" && event.source.userId.length > 0 &&
    event.source.userId.length <= 256 && match, "LINE_CONFIRMATION_INVALID");
  const hash = await sha256(BUTTON_PURPOSE + ":" + match[1]);
  const record = await ctx.db.prepare("SELECT store_id,nonce_hash FROM line_button_checks WHERE nonce_hash=? AND line_user_id=?")
    .bind(hash,event.source.userId).first();
  ensure(record, "LINE_CONFIRMATION_INVALID");
  const n = ctx.now();
  const result = await ctx.db.prepare(`UPDATE line_button_checks SET received_at=?
    WHERE store_id=? AND nonce_hash=? AND line_user_id=? AND received_at IS NULL AND EXISTS(${bound})`)
    .bind(n,record.store_id,hash,event.source.userId,...binding(record,n)).run();
  if (result.meta.changes === 1) return { ok:true, duplicate:false };
  const duplicate = await ctx.db.prepare(`SELECT 1 ok FROM line_button_checks
    WHERE store_id=? AND nonce_hash=? AND received_at IS NOT NULL AND EXISTS(${bound})`)
    .bind(record.store_id,hash,...binding(record,ctx.now())).first();
  ensure(duplicate,"LINE_CONFIRMATION_INVALID");
  return { ok:true, duplicate:true };
}
export async function confirmLineButton(ctx, actor, { confirmed } = {}) {
  requireButtonMode(ctx);
  ensure(confirmed === true, "CONFIRMATION_REQUIRED");
  const store = await requireStore(ctx,actor);
  const record = await ctx.db.prepare("SELECT store_id,nonce_hash FROM line_button_checks WHERE store_id=? AND owner_sub=? AND session_hash=? AND generation=?")
    .bind(store.id,actor.sub,actor.sessionHash,store.generation).first();
  ensure(record,"LINE_CONFIRMATION_INVALID");
  const n=ctx.now();
  try {
    await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO mutation_guards SELECT EXISTS(${bound}) AND EXISTS(
        SELECT 1 FROM line_button_checks WHERE store_id=? AND nonce_hash=? AND owner_sub=?
        AND session_hash=? AND received_at IS NOT NULL AND consumed_at IS NULL)`)
        .bind(...binding(record,n),store.id,record.nonce_hash,actor.sub,actor.sessionHash),
      ctx.db.prepare("UPDATE stores SET line_user_id=pending_line_user_id,pending_line_user_id=NULL,line_verified_at=?,state='line_verified',updated_at=? WHERE id=? AND state='line_pending' AND owner_sub=? AND generation=?")
        .bind(n,n,store.id,actor.sub,store.generation),
      ctx.db.prepare("UPDATE line_button_checks SET consumed_at=? WHERE store_id=? AND nonce_hash=? AND consumed_at IS NULL")
        .bind(n,store.id,record.nonce_hash),
      ctx.db.prepare("DELETE FROM line_checks WHERE store_id=?").bind(store.id),
      ctx.db.prepare("DELETE FROM mutation_guards"),
    ]);
  } catch (error) {
    if (/CHECK constraint failed/i.test(error.message)) throw new SelfError("LINE_CONFIRMATION_INVALID",409);
    throw error;
  }
  return { ok:true };
}
export async function readButtonCheck(ctx, store, sessionHash, delivery) {
  if (!readSelfConfig(ctx.env).lineButtonConfirm) return null;
  const record = delivery && await ctx.db.prepare("SELECT store_id,nonce_hash,expires_at,received_at FROM line_button_checks WHERE store_id=? AND attempt_id=? AND generation=? AND session_hash=?")
    .bind(store.id,delivery.attempt_id,store.generation,sessionHash).first();
  if (!record) return { method: delivery ? "pin" : "button", buttonAvailable:false };
  const live = await ctx.db.prepare(`SELECT 1 ok WHERE EXISTS(${bound})`).bind(...binding(record,ctx.now())).first();
  // Keep the method marker until its parent link/session is purged. An expired
  // button must not silently become PIN mode. Holds/rejections have no usable card.
  return { method:"button", buttonAvailable:Boolean(live && record.received_at !== null),
    expiresAt:live ? record.expires_at : null };
}
