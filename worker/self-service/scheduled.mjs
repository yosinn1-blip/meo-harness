import { readSelfConfig } from "./config.mjs";
import { LIMITS, dateKeys, jstDayStart, jstHour } from "./contracts.mjs";
import { purgeExpired } from "./retention.mjs";
import { pollSelfStore, processSelfJobs } from "./ingestion.mjs";
import { sendSelfDigest, usedDaySql } from "./notifications.mjs";
import { reconcileReply } from "./approvals.mjs";

// The cron runs every 5 minutes and each run does one small job, chosen by the
// UTC minute of its scheduled time (so a late run keeps its slot). Per hour:
// cleanup 1, poll 2, draft 5, notify 3, settle 1. Throughput comes from the
// number of runs; one run stays at or below the old per-run weight.
export const ROLES = Object.freeze([
  "cleanup", // :00 (also the only slot that runs legacy KV work, see index.mjs)
  "poll", //    :05
  "draft", //   :10
  "notify", //  :15
  "draft", //   :20
  "settle", //  :25
  "draft", //   :30
  "poll", //    :35
  "draft", //   :40
  "notify", //  :45
  "draft", //   :50
  "notify", //  :55
]);
export function slotIndex(t) {
  return Math.floor(new Date(t).getUTCMinutes() / 5);
}
export function slotRole(t) {
  return ROLES[slotIndex(t)];
}
export function legacyCronDue(t) {
  return slotIndex(t) === 0;
}
// An empty slot hands over to one other job, never a chain.
const FALLBACK = { poll: "draft", notify: "draft", settle: "draft", draft: "notify" };
const RUN = { poll: runPoll, draft: runDraft, notify: runNotify, settle: runSettle };

export async function runSelfScheduled(ctx, { scheduledTime = ctx.now() } = {}) {
  if (!ctx.db) return { role: null, did: false };
  const role = slotRole(scheduledTime);
  if (role === "cleanup") {
    await purgeExpired(ctx);
    return { role, did: true };
  }
  if (!readSelfConfig(ctx.env).processingEnabled) return { role, did: false };
  // Deadlines, leases and the JST 09:00 rule keep using ctx.now().
  if (await RUN[role](ctx)) return { role, did: true };
  const fallback = FALLBACK[role];
  return { role, did: false, fallback, fallbackDid: await RUN[fallback](ctx) };
}

export async function pickPollStore(ctx) {
  return ctx.db
    .prepare(
      "SELECT id FROM stores WHERE state='active' AND (last_polled_at IS NULL OR last_polled_at<=?) ORDER BY COALESCE(last_polled_at,0),id LIMIT 1",
    )
    .bind(ctx.now() - LIMITS.pollMinIntervalMs)
    .first();
}
async function runPoll(ctx) {
  const store = await pickPollStore(ctx);
  if (!store) return false;
  try {
    await pollSelfStore(ctx, store.id);
  } catch {
    // Failed polls still rotate to the next store.
    await ctx.db
      .prepare("UPDATE stores SET last_error=?,last_polled_at=? WHERE id=?")
      .bind("GOOGLE_POLL_FAILED", ctx.now(), store.id)
      .run();
  }
  return true;
}
async function runDraft(ctx) {
  return (await processSelfJobs(ctx, { limit: 1 })) > 0;
}

// Only from JST 09:00 to 20:59 (LIMITS.notifyEndHourJst), retries included.
// The store that has waited longest since it became deliverable: a due digest
// retry waits from its due time, a new digest from max(oldest draft + the
// minimum age, JST 09:00 today). A retry is re-due after every attempt, so a
// store whose LINE keeps failing can never keep a waiting new digest out (a
// tie goes to the retry). Stores with nothing to deliver (a draft whose review
// text is past its 7-day keep cannot be delivered), or whose JST day is
// already used, are never picked.
export async function pickNotifyStore(ctx) {
  const now = ctx.now();
  if (jstHour(now) < 9 || jstHour(now) >= LIMITS.notifyEndHourJst) return null;
  return ctx.db
    .prepare(
      `WITH d AS (SELECT r.store_id,count(*) c,MIN(j.created_at) oldest FROM replies r JOIN review_jobs j ON j.id=r.job_id JOIN stores s ON s.id=r.store_id
 WHERE r.state='pending' AND j.stage='draft_ready' AND r.generation=s.generation AND r.expires_at>?1
 AND j.created_at>?8 AND j.payload_ciphertext IS NOT NULL AND r.draft_ciphertext IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM notification_items i WHERE i.reply_id=r.id) GROUP BY r.store_id),
u AS (SELECT j.store_id,count(*) c FROM review_jobs j JOIN stores s ON s.id=j.store_id
 WHERE j.stage IN ('fetched','drafting') AND j.generation=s.generation AND j.next_attempt_at<=?1 AND j.payload_ciphertext IS NOT NULL GROUP BY j.store_id),
t AS (SELECT n.store_id,MIN(n.next_attempt_at) due FROM notification_jobs n JOIN stores s ON s.id=n.store_id
 WHERE n.state='pending' AND n.generation=s.generation AND n.payload_ciphertext IS NOT NULL AND n.next_attempt_at<=?1 AND (n.lease_until IS NULL OR n.lease_until<=?1) GROUP BY n.store_id)
SELECT s.id FROM stores s LEFT JOIN d ON d.store_id=s.id LEFT JOIN u ON u.store_id=s.id LEFT JOIN t ON t.store_id=s.id
WHERE s.state='active' AND s.line_user_id IS NOT NULL AND (t.store_id IS NOT NULL OR (
 d.store_id IS NOT NULL AND d.oldest<=?2 AND (d.c>=5 OR COALESCE(u.c,0)=0 OR d.oldest<=?3)
 AND NOT EXISTS (SELECT 1 FROM notification_jobs n WHERE n.store_id=s.id AND ${usedDaySql("?4", "?5")})
 AND NOT EXISTS (SELECT 1 FROM notification_jobs n WHERE n.store_id=s.id AND n.generation=s.generation AND n.state='pending' AND n.payload_ciphertext IS NOT NULL)))
ORDER BY COALESCE(t.due,MAX(d.oldest+?6,?7)),(t.store_id IS NULL),COALESCE(t.due,d.oldest),s.id LIMIT 1`,
    )
    .bind(
      now,
      now - LIMITS.notifyMinAgeMs,
      now - LIMITS.notifyBatchWaitMs,
      dateKeys(now).day,
      jstDayStart(now),
      LIMITS.notifyMinAgeMs,
      jstDayStart(now) + 9 * 3600000,
      now - LIMITS.reviewKeepMs,
    )
    .first();
}
async function runNotify(ctx) {
  const store = await pickNotifyStore(ctx);
  if (!store) return false;
  try {
    await sendSelfDigest(ctx, store.id);
  } catch {
    await ctx.db
      .prepare("UPDATE stores SET last_error=? WHERE id=?")
      .bind("LINE_NOTIFICATION_HELD", store.id)
      .run();
  }
  return true;
}

async function runSettle(ctx) {
  await ctx.db
    .prepare(
      "UPDATE replies SET state='cancelled' WHERE state IN ('posting','post_unknown') AND NOT EXISTS(SELECT 1 FROM stores s WHERE s.id=replies.store_id AND s.generation=replies.generation AND s.state='active')",
    )
    .run();
  await ctx.db
    .prepare(
      "UPDATE replies SET state='expired' WHERE state IN ('posting','post_unknown') AND expires_at<=? AND EXISTS(SELECT 1 FROM review_jobs j WHERE j.id=replies.job_id AND (j.lease_until IS NULL OR j.lease_until<=?))",
    )
    .bind(ctx.now(), ctx.now())
    .run();
  await ctx.db
    .prepare(
      "UPDATE review_jobs SET stage=(SELECT state FROM replies WHERE job_id=review_jobs.id),lease_id=NULL,lease_until=NULL WHERE stage IN ('posting','post_unknown') AND EXISTS(SELECT 1 FROM replies r WHERE r.job_id=review_jobs.id AND r.state IN ('cancelled','expired'))",
    )
    .run();
  const unknown = await ctx.db
    .prepare(
      "SELECT r.id FROM replies r JOIN review_jobs j ON j.id=r.job_id JOIN stores s ON s.id=r.store_id WHERE r.state IN ('post_unknown','posting') AND (j.lease_until IS NULL OR j.lease_until<=?) AND j.next_attempt_at<=? AND s.state='active' AND r.generation=s.generation AND r.expires_at>? AND r.draft_ciphertext IS NOT NULL AND j.payload_ciphertext IS NOT NULL ORDER BY j.next_attempt_at,j.updated_at,r.id LIMIT 1",
    )
    .bind(ctx.now(), ctx.now(), ctx.now())
    .all();
  for (const r of unknown.results) {
    try {
      await reconcileReply(ctx, r.id);
    } catch {
      /* no automatic PUT on ambiguous results */
    }
  }
  return unknown.results.length > 0;
}
