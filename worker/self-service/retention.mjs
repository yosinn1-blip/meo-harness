import { disconnectStore } from "./lifecycle.mjs";
export async function purgeExpired(ctx) {
  if (!ctx.db) return;
  const n = ctx.now();
  const expired = await ctx.db
    .prepare(
      "SELECT s.owner_sub FROM stores s WHERE s.state IN ('location_selected','line_pending','line_verified','ready') AND s.updated_at<? LIMIT 100",
    )
    .bind(n - 86400000)
    .all();
  for (const row of expired.results)
    await disconnectStore(ctx, { sub: row.owner_sub });
  await ctx.db.batch([
    ctx.db
      .prepare(
        "DELETE FROM line_events WHERE event_id IN (SELECT event_id FROM line_events WHERE created_at<? LIMIT 100)",
      )
      .bind(n - 30 * 86400000),
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
        "UPDATE replies SET draft_ciphertext=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE id IN (SELECT id FROM replies WHERE expires_at<=? AND draft_ciphertext IS NOT NULL LIMIT 100)",
      )
      .bind(n),
    ctx.db
      .prepare(
        "UPDATE review_jobs SET payload_ciphertext=NULL WHERE id IN (SELECT id FROM review_jobs WHERE created_at<? AND payload_ciphertext IS NOT NULL LIMIT 100)",
      )
      .bind(n - 7 * 86400000),
    ctx.db
      .prepare(
        "UPDATE notification_jobs SET payload_ciphertext=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE id IN (SELECT id FROM notification_jobs WHERE expires_at<=? AND payload_ciphertext IS NOT NULL LIMIT 100)",
      )
      .bind(n),
    ctx.db
      .prepare(
        "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at<? LIMIT 100)",
      )
      .bind(n - 30 * 86400000),
  ]);
}
