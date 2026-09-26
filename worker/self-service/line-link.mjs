import { LIMITS, dateKeys } from "./contracts.mjs";
import { ensure, SelfError } from "./errors.mjs";
import { sha256, hmac, safeEqual } from "./crypto.mjs";
import { requireStore } from "./store-repository.mjs";
import { consumeRate } from "./abuse.mjs";
export function authorizeLineActor({ source, registeredUserId, active }) {
  return Boolean(
    active &&
      registeredUserId &&
      source?.type === "user" &&
      source.userId === registeredUserId,
  );
}
export async function issueLineCode(ctx, actor) {
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
export async function consumeLineCode(ctx, event) {
  ensure(
    event.source?.type === "user" && event.source.userId,
    "LINE_USER_REQUIRED",
  );
  const code = event.message?.text?.trim().toUpperCase();
  ensure(/^MEOS-[A-HJ-NP-Z2-9]{12}$/.test(code), "LINE_CODE_INVALID");
  const hash = await sha256(code),
    now = ctx.now();
  const result = await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE stores SET pending_line_user_id=?,updated_at=? WHERE state='line_pending' AND id IN (SELECT store_id FROM line_links WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL)",
      )
      .bind(event.source.userId, now, hash, now),
    ctx.db
      .prepare(
        "UPDATE line_links SET consumed_at=? WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL RETURNING store_id",
      )
      .bind(now, hash, now),
  ]);
  ensure(
    result[0].meta.changes === 1 && result[1].results.length === 1,
    "LINE_CODE_INVALID",
  );
  return { ok: true };
}
export async function sendLineCheck(ctx, actor) {
  const s = await requireStore(ctx, actor);
  ensure(
    s.state === "line_pending" && s.pendingLineUserId,
    "LINE_PENDING_REQUIRED",
    409,
  );
  const link = await ctx.db
    .prepare("SELECT session_hash FROM line_links WHERE store_id=?")
    .bind(s.id)
    .first();
  ensure(
    link?.session_hash === actor.sessionHash,
    "LINE_BROWSER_MISMATCH",
    403,
  );
  await consumeRate(ctx, {
    bucket: "test-minute:" + s.id,
    limit: 1,
    windowMs: 60000,
  });
  await consumeRate(ctx, {
    bucket: "test-day:" + s.id + ":" + dateKeys(ctx.now()).day,
    limit: 3,
    windowMs: 86400000,
  });
  const { reservePush, sendReservedPush } = await import("./budget.mjs");
  const id = "line-test:" + crypto.randomUUID();
  const reservation = await reservePush(ctx, { id, storeId: s.id });
  ensure(reservation.ok, "QUOTA_EXHAUSTED", 429);
  let n;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (n >= 4294000000);
  const pin = String(n % 1000000).padStart(6, "0");
  await ctx.db
    .prepare("INSERT OR REPLACE INTO line_checks VALUES (?,?,?,?,0,?)")
    .bind(
      s.id,
      await hmac(pin, ctx.env.SELF_RATE_KEY + ":" + s.id),
      s.generation,
      actor.sessionHash,
      ctx.now() + LIMITS.pinMs,
    )
    .run();
  const current = await requireStore(ctx, actor);
  ensure(
    current.generation === s.generation && current.state === "line_pending",
    "STORE_CHANGED",
    409,
  );
  await sendReservedPush(ctx, {
    id,
    to: s.pendingLineUserId,
    messages: [
      {
        type: "text",
        text: `MEO Harness 確認番号: ${pin}\n5分以内に登録画面へ入力してください。`,
      },
    ],
    retryKey: crypto.randomUUID(),
  });
  return { ok: true, expiresAt: ctx.now() + LIMITS.pinMs };
}
export async function verifyLinePin(ctx, actor, pin) {
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
