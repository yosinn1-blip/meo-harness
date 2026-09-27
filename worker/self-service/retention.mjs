import { disconnectStore } from "./lifecycle.mjs";
import { dateKeys } from "./contracts.mjs";
import { migrateDraftBudget } from "./budget.mjs";
export async function purgeExpired(ctx) {
  if (!ctx.db) return;
  const n = ctx.now();
  const usageCutoff = n - 90 * 86400000;
  const usageMonth = dateKeys(usageCutoff).month;
  const draftCutoff = n - 7 * 86400000;
  const draftMonth = dateKeys(draftCutoff).month;
  await migrateDraftBudget(ctx);
  const expired = await ctx.db
    .prepare(
      "SELECT s.id,s.owner_sub,s.generation,s.metadata_fetched_at FROM stores s WHERE (s.terms_version IS NULL AND s.updated_at<?) OR s.metadata_fetched_at IS NULL OR s.metadata_fetched_at<=? ORDER BY COALESCE(s.metadata_fetched_at,0),s.updated_at,s.id LIMIT 1",
    )
    .bind(n - 86400000, n - 21 * 86400000)
    .all();
  for (const row of expired.results)
    await disconnectStore(ctx, { sub: row.owner_sub },
      row.metadata_fetched_at === null || row.metadata_fetched_at <= n - 21 * 86400000
        ? {expiredMetadata:{storeId:row.id,generation:row.generation,fetchedAt:row.metadata_fetched_at,before:n-21*86400000}}
        : {abandoned: { storeId: row.id, before: n - 86400000 }});
  await ctx.db.batch([
    ctx.db
      .prepare(
        "DELETE FROM line_events WHERE event_id IN (SELECT event_id FROM line_events WHERE created_at<? LIMIT 100)",
      )
      .bind(n - 30 * 86400000),
    ctx.db.prepare("DELETE FROM line_edits WHERE expires_at<=?").bind(n),
    ctx.db.prepare(
      "DELETE FROM reply_revisions WHERE reply_id IN (SELECT v.reply_id FROM reply_revisions v LEFT JOIN replies r ON r.id=v.reply_id WHERE r.id IS NULL OR r.draft_ciphertext IS NULL LIMIT 100)",
    ),
    ...[
      "oauth_attempts",
      "sessions",
      "line_links",
      "line_checks",
      "location_cursors",
      "location_candidates",
    ].map((table) =>
      ctx.db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at<=? LIMIT 100)`,
        )
        .bind(n),
    ),
    ctx.db
      .prepare(
        "DELETE FROM rate_limits WHERE bucket IN (SELECT bucket FROM rate_limits WHERE expires_at<=? LIMIT 100)",
      )
      .bind(n),
    ctx.db
      .prepare(
        "DELETE FROM google_credentials WHERE owner_sub IN (SELECT owner_sub FROM google_credentials WHERE updated_at<? AND owner_sub NOT IN (SELECT owner_sub FROM stores) LIMIT 100)",
      )
      .bind(n - 86400000),
    ctx.db
      .prepare(
        "DELETE FROM users WHERE sub IN (SELECT u.sub FROM users u WHERE u.created_at<? AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM google_credentials c WHERE c.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM oauth_attempts a WHERE a.owner_sub=u.sub) LIMIT 100)",
      )
      .bind(n - 86400000),
    ctx.db
      .prepare(
        "UPDATE replies SET draft_ciphertext=NULL,draft_hash='',state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE id IN (SELECT id FROM replies WHERE expires_at<=? AND (draft_ciphertext IS NOT NULL OR draft_hash<>'') LIMIT 100)",
      )
      .bind(n),
    ctx.db
      .prepare(
        "UPDATE review_jobs SET payload_ciphertext=NULL WHERE id IN (SELECT id FROM review_jobs WHERE created_at<? AND payload_ciphertext IS NOT NULL LIMIT 100)",
      )
      .bind(n - 7 * 86400000),
    // Keep only local deduplication / processing tokens, not raw Google IDs.
    // A fresh API read may rehydrate a still-fetched job, never a skipped/posted job.
    ctx.db.prepare("UPDATE review_jobs SET review_id='expired:'||id,review_version=id,payload_ciphertext=NULL WHERE id IN (SELECT id FROM review_jobs WHERE created_at<=? AND review_id NOT LIKE 'expired:%' LIMIT 100)").bind(n-21*86400000),
    ctx.db.prepare("UPDATE poll_cursors SET page_token=NULL WHERE scan_started_at<=?").bind(n-21*86400000),
    ctx.db.prepare("DELETE FROM notification_items WHERE reply_id IN (SELECT id FROM replies WHERE job_id IN (SELECT id FROM review_jobs WHERE created_at<=? ORDER BY created_at,id LIMIT 100))").bind(n-70*86400000),
    ctx.db.prepare("DELETE FROM replies WHERE job_id IN (SELECT id FROM review_jobs WHERE created_at<=? ORDER BY created_at,id LIMIT 100)").bind(n-70*86400000),
    ctx.db.prepare("DELETE FROM review_jobs WHERE id IN (SELECT id FROM review_jobs WHERE created_at<=? ORDER BY created_at,id LIMIT 100)").bind(n-70*86400000),
    ctx.db
      .prepare(
        "UPDATE notification_jobs SET payload_ciphertext=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE id IN (SELECT id FROM notification_jobs WHERE expires_at<=? AND payload_ciphertext IS NOT NULL LIMIT 100)",
      )
      .bind(n),
    ctx.db.prepare("DELETE FROM notification_items WHERE notification_id IN (SELECT id FROM notification_jobs WHERE expires_at<? ORDER BY expires_at,id LIMIT 100)").bind(n-21*86400000),
    ctx.db.prepare("DELETE FROM notification_jobs WHERE id IN (SELECT id FROM notification_jobs WHERE expires_at<? ORDER BY expires_at,id LIMIT 100)").bind(n-21*86400000),
    ctx.db
      .prepare(
        "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at<? LIMIT 100)",
      )
      .bind(n - 30 * 86400000),
    // Never expire the current month's cap or a lifetime active-slot reservation.
    // Keep late-created reservations until they too have aged for 90 days.
    ctx.db
      .prepare(
        "DELETE FROM usage_reservations WHERE id IN (SELECT r.id FROM usage_reservations r WHERE (r.kind NOT IN ('active','draft') AND r.period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND r.period<? AND r.created_at<?) OR (r.kind='draft' AND r.period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND r.period<? AND r.created_at<?) OR (r.kind='active' AND r.state='released' AND NOT EXISTS (SELECT 1 FROM stores s WHERE r.id='active:'||s.id)) LIMIT 100)",
      )
      .bind(usageMonth, usageCutoff, draftMonth, draftCutoff),
    ctx.db
      .prepare(
        "DELETE FROM usage_budgets WHERE rowid IN (SELECT b.rowid FROM usage_budgets b WHERE b.kind<>'active' AND b.period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND b.period<CASE WHEN b.kind='draft' THEN ? ELSE ? END AND NOT EXISTS (SELECT 1 FROM usage_reservations r WHERE r.scope=b.scope AND r.period=b.period AND r.kind=b.kind) LIMIT 100)",
      )
      .bind(draftMonth, usageMonth),
  ]);
}
