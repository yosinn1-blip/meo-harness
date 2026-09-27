import { readSelfConfig } from "./config.mjs";
import { purgeExpired } from "./retention.mjs";
import { pollSelfStore, processSelfJobs } from "./ingestion.mjs";
import { sendSelfDigest } from "./notifications.mjs";
import { reconcileReply } from "./approvals.mjs";
export async function runSelfScheduled(ctx) {
  if (!ctx.db) return;
  await purgeExpired(ctx);
  if (!readSelfConfig(ctx.env).processingEnabled) return;
  // Bound whole invocations, not just individual loops. Splitting hourly phases
  // leaves room for failure settlement, cleanup and existing KV processing.
  const hour = Math.floor(ctx.now() / 3600000);
  if (hour % 2 === 0) {
    const store = await ctx.db.prepare(
      "SELECT id FROM stores WHERE state='active' ORDER BY COALESCE(last_polled_at,0),id LIMIT 1",
    ).first();
    if (store) {
      try { await pollSelfStore(ctx, store.id); }
      catch {
        await ctx.db.prepare("UPDATE stores SET last_error=?,last_polled_at=? WHERE id=?")
          .bind("GOOGLE_POLL_FAILED", ctx.now(), store.id).run();
      }
    }
    await processSelfJobs(ctx, { limit: 1 });
    return;
  }
  // Round-robin notification turns independently of successful Google polling.
  const stores = await ctx.db.prepare(
    "SELECT id FROM stores WHERE state='active' ORDER BY id LIMIT 1 OFFSET (? % MAX(1,(SELECT count(*) FROM stores WHERE state='active')))",
  ).bind(Math.floor(hour / 2)).all();
  for (const s of stores.results) {
    try {
      await sendSelfDigest(ctx, s.id);
    } catch {
      await ctx.db
        .prepare("UPDATE stores SET last_error=? WHERE id=?")
        .bind("LINE_NOTIFICATION_HELD", s.id)
        .run();
    }
  }
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
}
