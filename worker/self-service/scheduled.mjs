import { readSelfConfig, createSelfContext } from "./config.mjs";
import { purgeExpired } from "./retention.mjs";
import { pollSelfStore, processSelfJobs } from "./ingestion.mjs";
import { sendSelfDigest } from "./notifications.mjs";
import { reconcileReply } from "./approvals.mjs";
export async function runSelfScheduled(ctx) {
  if (!ctx.db) return;
  await purgeExpired(ctx);
  if (!readSelfConfig(ctx.env).processingEnabled) return;
  const stores = await ctx.db
    .prepare(
      "SELECT id FROM stores WHERE state='active' ORDER BY COALESCE(last_polled_at,0),id LIMIT 5",
    )
    .all();
  for (let i = 0; i < stores.results.length; i += 2)
    await Promise.all(
      stores.results.slice(i, i + 2).map(async (s) => {
        try {
          await pollSelfStore(ctx, s.id);
        } catch {
          await ctx.db
            .prepare("UPDATE stores SET last_error=? WHERE id=?")
            .bind("GOOGLE_POLL_FAILED", s.id)
            .run();
        }
      }),
    );
  await processSelfJobs(ctx, { limit: 5 });
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
  const unknown = await ctx.db
    .prepare(
      "SELECT r.id FROM replies r JOIN review_jobs j ON j.id=r.job_id WHERE r.state='post_unknown' OR r.state='posting' AND j.lease_until<=? LIMIT 5",
    )
    .bind(ctx.now())
    .all();
  for (const r of unknown.results) {
    try {
      await reconcileReply(ctx, r.id);
    } catch {
      /* no automatic PUT on ambiguous results */
    }
  }
}
