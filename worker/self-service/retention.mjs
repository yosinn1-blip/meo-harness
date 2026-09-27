import { disconnectStore } from "./lifecycle.mjs";
import { dateKeys } from "./contracts.mjs";
export async function purgeExpired(ctx) {
  if (!ctx.db) return;
  const n = ctx.now();
  const usageCutoff = n - 90 * 86400000;
  const usageMonth = dateKeys(usageCutoff).month;
  const expired = await ctx.db
    .prepare(
      "SELECT s.id,s.owner_sub FROM stores s WHERE s.terms_version IS NULL AND s.updated_at<? ORDER BY s.updated_at,s.id LIMIT 100",
    )
    .bind(n - 86400000)
    .all();
  for (const row of expired.results)
    await disconnectStore(ctx, { sub: row.owner_sub }, {
      abandoned: { storeId: row.id, before: n - 86400000 },
    });
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
        "DELETE FROM users WHERE sub IN (SELECT u.sub FROM users u WHERE u.created_at<? AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM google_credentials c WHERE c.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.owner_sub=u.sub) AND NOT EXISTS (SELECT 1 FROM oauth_attempts a WHERE a.owner_sub=u.sub) LIMIT 100)",
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
    // Never expire the current month's cap or a lifetime active-slot reservation.
    // Keep late-created reservations until they too have aged for 90 days.
    ctx.db
      .prepare(
        "DELETE FROM usage_reservations WHERE id IN (SELECT r.id FROM usage_reservations r WHERE (r.kind<>'active' AND r.period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND r.period<? AND r.created_at<?) OR (r.kind='active' AND r.state='released' AND NOT EXISTS (SELECT 1 FROM stores s WHERE r.id='active:'||s.id)) LIMIT 100)",
      )
      .bind(usageMonth, usageCutoff),
    ctx.db
      .prepare(
        "DELETE FROM usage_budgets WHERE rowid IN (SELECT b.rowid FROM usage_budgets b WHERE b.kind<>'active' AND b.period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND b.period<? AND NOT EXISTS (SELECT 1 FROM usage_reservations r WHERE r.scope=b.scope AND r.period=b.period AND r.kind=b.kind) LIMIT 100)",
      )
      .bind(usageMonth),
  ]);
}
