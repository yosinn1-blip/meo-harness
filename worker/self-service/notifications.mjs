import { readSelfConfig } from "./config.mjs";
import { LIMITS, dateKeys, jstDayStart, jstHour } from "./contracts.mjs";
import { getStore } from "./store-repository.mjs";
import { storeGuard } from "./lifecycle.mjs";
import { seal, unseal, tokenKey } from "./crypto.mjs";
import { reservePush, sendReservedPush } from "./budget.mjs";
import { buildFlexPayload } from "../../src/line-flex.mjs";
import { ensure } from "./errors.mjs";
// A store's JST day is used by any digest keyed to it, or by any digest that
// was attempted or accepted on it. last_attempt_at (0006) is the time this
// code last called LINE's push for the digest: written just before the push
// and, on acceptance, set to the acceptance time in the same transaction as
// the push reservation commit (so the acceptance day is held even if the row's
// own save then fails). Attempts only start from JST 09:00 to 20:59 (an attempt
// begun at 20:59:59 may finish seconds after 21:00), so a push is never
// accepted on the JST day after its attempt. A claim that does not
// call LINE (quota hold, inactive store, or the local close of an already
// committed reservation) never writes it.
// next_attempt_at is only the retry due time and lease_until only the lease.
// Rows written before 0006 have no last_attempt_at, so their retry or
// acceptance time is unknown: such a row with a first attempt in the last
// 24 h (the safety stop ends every attempt within 24 h of the first) holds
// the day, which can only over-hold, never allow a second LINE.
export function usedDaySql(dayParam, dayStartParam) {
  return `(n.day_key=${dayParam} OR n.first_attempt_at>=${dayStartParam} OR n.last_attempt_at>=${dayStartParam} OR (n.last_attempt_at IS NULL AND n.first_attempt_at IS NOT NULL AND n.first_attempt_at>=${dayStartParam}-86400000))`;
}
export async function sendSelfDigest(ctx, storeId) {
  if (!readSelfConfig(ctx.env).processingEnabled) return;
  // Start only from JST 09:00 to 20:59, retries of an earlier day's digest
  // included: the morning promise, and no push accepted after JST midnight
  // (see usedDaySql). The check is at the start of the attempt.
  if (jstHour(ctx.now()) < 9 || jstHour(ctx.now()) >= LIMITS.notifyEndHourJst) return;
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
    if (
      await ctx.db
        .prepare(
          "SELECT id FROM notification_jobs n WHERE n.store_id=?1 AND " + usedDaySql("?2", "?3"),
        )
        .bind(storeId, day, jstDayStart(ctx.now()))
        .first()
    )
      return;
    const rows = await ctx.db
      .prepare(
        "SELECT r.*,j.payload_ciphertext,j.created_at AS job_created_at FROM replies r JOIN review_jobs j ON j.id=r.job_id WHERE r.store_id=? AND r.generation=? AND r.state='pending' AND j.stage='draft_ready' AND r.expires_at>? AND j.created_at>? AND j.payload_ciphertext IS NOT NULL AND r.draft_ciphertext IS NOT NULL AND r.id NOT IN (SELECT reply_id FROM notification_items) ORDER BY j.created_at,r.id LIMIT 5",
      )
      .bind(storeId, store.generation, ctx.now(), ctx.now() - LIMITS.reviewKeepMs)
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
        editable: true,
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
    if (!reservation.ok) {
      // Quota exhausted/unknown: hold this digest for an hour instead of
      // re-reading the LINE quota in every notify slot.
      await ctx.db
        .prepare(
          "UPDATE notification_jobs SET next_attempt_at=? WHERE id=? AND lease_id=?",
        )
        .bind(ctx.now() + 3600000, notification.id, lease)
        .run();
      return;
    }
    const current = await getStore(ctx, storeId);
    ensure(
      current?.state === "active" &&
        current.generation === notification.generation,
      "STORE_INACTIVE",
      409,
    );
    // An already committed reservation means LINE accepted this digest in an
    // earlier attempt whose row update was lost: close it locally without
    // calling LINE and keep that attempt's time (see usedDaySql).
    const callsLine = !reservation.committed;
    if (callsLine)
      await ctx.db
        .prepare(
          "UPDATE notification_jobs SET first_attempt_at=COALESCE(first_attempt_at,?),last_attempt_at=? WHERE id=? AND lease_id=?",
        )
        .bind(ctx.now(), ctx.now(), notification.id, lease)
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
      onAccepted: (acceptedAt) => [
        ctx.db
          .prepare("UPDATE notification_jobs SET last_attempt_at=? WHERE id=?")
          .bind(acceptedAt, notification.id),
      ],
    });
    await ctx.db.batch([
      ctx.db
        .prepare(
          // last_attempt_at was saved with the reservation commit.
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
    } else {
      // Result unknown (timeout/5xx) or an unexpected failure: keep the same
      // reservation and retry key (LINE de-duplicates it) and the 24 h stop,
      // but wait 30 min so this digest does not take every notify slot.
      await ctx.db
        .prepare(
          "UPDATE notification_jobs SET next_attempt_at=? WHERE id=? AND lease_id=?",
        )
        .bind(ctx.now() + 1800000, notification.id, lease)
        .run()
        .catch(() => {});
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
