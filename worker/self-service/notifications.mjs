import { readSelfConfig } from "./config.mjs";
import { dateKeys } from "./contracts.mjs";
import { getStore } from "./store-repository.mjs";
import { storeGuard } from "./lifecycle.mjs";
import { seal, unseal, tokenKey } from "./crypto.mjs";
import { reservePush, sendReservedPush } from "./budget.mjs";
import { buildFlexPayload } from "../../src/line-flex.mjs";
import { ensure } from "./errors.mjs";
export async function sendSelfDigest(ctx, storeId) {
  if (!readSelfConfig(ctx.env).processingEnabled) return;
  const store = await getStore(ctx, storeId);
  if (store?.state !== "active" || !store.lineUserId) return;
  let notification = await ctx.db
    .prepare(
      "SELECT * FROM notification_jobs WHERE store_id=? AND generation=? AND state='pending' AND payload_ciphertext IS NOT NULL ORDER BY day_key LIMIT 1",
    )
    .bind(storeId, store.generation)
    .first();
  if (!notification) {
    const day = dateKeys(ctx.now()).day;
    if (new Date(ctx.now() + 9 * 3600000).getUTCHours() < 9) return;
    if (
      await ctx.db
        .prepare(
          "SELECT id FROM notification_jobs WHERE store_id=? AND day_key=?",
        )
        .bind(storeId, day)
        .first()
    )
      return;
    const rows = await ctx.db
      .prepare(
        "SELECT r.*,j.payload_ciphertext,j.created_at AS job_created_at FROM replies r JOIN review_jobs j ON j.id=r.job_id WHERE r.store_id=? AND r.generation=? AND r.state='pending' AND j.stage='draft_ready' AND r.expires_at>? AND r.id NOT IN (SELECT reply_id FROM notification_items) ORDER BY j.created_at,r.id LIMIT 5",
      )
      .bind(storeId, store.generation, ctx.now())
      .all();
    if (!rows.results.length) return;
    const reviews = [];
    for (const row of rows.results) {
      const review = JSON.parse(
        await unseal(
          row.payload_ciphertext,
          tokenKey(ctx),
          "job:" + row.job_id,
        ),
      );
      reviews.push({
        ...review,
        name: (review.name ?? "匿名").slice(0, 80),
        replyId: row.id,
        draft: await unseal(
          row.draft_ciphertext,
          tokenKey(ctx),
          "reply:" + row.id,
        ),
        fullTextUrl: ctx.env.SELF_PUBLIC_ORIGIN + "/account/replies/" + row.id,
      });
    }
    const payload = buildFlexPayload({
      to: store.lineUserId,
      reviews,
      bizName: store.title.slice(0, 80),
    });
    const id = "digest:" + storeId + ":" + day;
    const ciphertext = await seal(
      JSON.stringify(payload),
      tokenKey(ctx),
      "notification:" + id,
    );
    try {
      await ctx.db.batch([
        storeGuard(ctx, store, ["active"]),
        ctx.db
          .prepare(
            "INSERT INTO notification_jobs(id,store_id,generation,day_key,part,retry_key,payload_ciphertext,expires_at,state) VALUES (?,?,?,?,0,?,?,?,'pending')",
          )
          .bind(
            id,
            storeId,
            store.generation,
            day,
            crypto.randomUUID(),
            ciphertext,
            Math.min(
              ...rows.results.map((row) =>
                Math.min(row.expires_at, row.job_created_at + 7 * 86400000),
              ),
            ),
          ),
        ...rows.results.map((row) =>
          ctx.db
            .prepare("INSERT INTO notification_items VALUES (?,?)")
            .bind(id, row.id),
        ),
        ctx.db.prepare("DELETE FROM mutation_guards"),
      ]);
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(e.message)) throw e;
      return;
    }
    notification = await ctx.db
      .prepare("SELECT * FROM notification_jobs WHERE id=?")
      .bind(id)
      .first();
  }
  if (notification.expires_at <= ctx.now()) {
    await ctx.db
      .prepare(
        "UPDATE notification_jobs SET state='expired',payload_ciphertext=NULL WHERE id=?",
      )
      .bind(notification.id)
      .run();
    return;
  }
  if (
    notification.first_attempt_at !== null &&
    ctx.now() - notification.first_attempt_at >= 86400000
  ) {
    await ctx.db
      .prepare("UPDATE notification_jobs SET state='unknown' WHERE id=?")
      .bind(notification.id)
      .run();
    return;
  }
  if (notification.next_attempt_at > ctx.now()) return;
  const lease = crypto.randomUUID();
  const claim = await ctx.db
    .prepare(
      "UPDATE notification_jobs SET lease_id=?,lease_until=? WHERE id=? AND state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING *",
    )
    .bind(lease, ctx.now() + 60000, notification.id, ctx.now(), ctx.now())
    .first();
  if (!claim) return;
  notification = claim;
  const reservationId = notification.id + ":attempt:" + notification.attempt_no;
  try {
    const reservation = await reservePush(ctx, {
      id: reservationId,
      storeId,
    });
    if (!reservation.ok) return;
    const current = await getStore(ctx, storeId);
    ensure(
      current?.state === "active" &&
        current.generation === notification.generation,
      "STORE_INACTIVE",
      409,
    );
    await ctx.db
      .prepare(
        "UPDATE notification_jobs SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=? AND lease_id=?",
      )
      .bind(ctx.now(), notification.id, lease)
      .run();
    const payload = JSON.parse(
      await unseal(
        notification.payload_ciphertext,
        tokenKey(ctx),
        "notification:" + notification.id,
      ),
    );
    const result = await sendReservedPush(ctx, {
      id: reservationId,
      ...payload,
      retryKey: notification.retry_key,
    });
    await ctx.db.batch([
      ctx.db
        .prepare(
          "UPDATE notification_jobs SET state='accepted',accepted_request_id=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",
        )
        .bind(result.requestId ?? null, notification.id, lease),
      ctx.db
        .prepare(
          "UPDATE review_jobs SET stage='notified',updated_at=? WHERE id IN (SELECT r.job_id FROM replies r JOIN notification_items n ON n.reply_id=r.id WHERE n.notification_id=?) AND stage='draft_ready'",
        )
        .bind(ctx.now(), notification.id),
    ]);
  } catch (e) {
    if (["LINE_RETRY_REQUIRED", "LINE_SEND_FAILED"].includes(e.code)) {
      const delay = [60000, 300000, 1800000][
        Math.min(notification.attempt_no, 2)
      ];
      await ctx.db
        .prepare(
          "UPDATE notification_jobs SET attempt_no=attempt_no+1,next_attempt_at=?,state=? WHERE id=? AND lease_id=?",
        )
        .bind(
          ctx.now() + delay,
          notification.attempt_no >= 4 ? "blocked" : "pending",
          notification.id,
          lease,
        )
        .run();
    }
    throw e;
  } finally {
    await ctx.db
      .prepare(
        "UPDATE notification_jobs SET lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",
      )
      .bind(notification.id, lease)
      .run();
  }
}
