import { ensure, SelfError } from "./errors.mjs";
import { requireStore, findOwnedStore } from "./store-repository.mjs";
import { verifyLocationAccess } from "./locations.mjs";
import { readSelfConfig } from "./config.mjs";
import { budgetStatement, reservationStatement } from "./budget.mjs";
export function storeGuard(ctx, store, states) {
  const placeholders = states.map(() => "?").join(",");
  return ctx.db
    .prepare(
      `INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM stores WHERE id=? AND generation=? AND state IN (${placeholders}))`,
    )
    .bind(store.id, store.generation, ...states);
}
export async function activateStore(ctx, actor, { termsVersion, confirmed }) {
  const c = readSelfConfig(ctx.env);
  ensure(
    c.processingEnabled &&
      confirmed === true &&
      termsVersion &&
      termsVersion === ctx.env.SELF_TERMS_VERSION,
    "ACTIVATION_NOT_READY",
    409,
  );
  const s = await requireStore(ctx, actor);
  ensure(
    s.lineUserId &&
      s.lineVerifiedAt &&
      ["line_verified", "ready", "paused", "active"].includes(s.state),
    "LINE_VERIFICATION_REQUIRED",
    409,
  );
  const actual=await verifyLocationAccess(ctx, actor, s, {refreshAccount:true});
  try {
    await ctx.db.batch([
      storeGuard(ctx, s, ["line_verified", "ready", "paused", "active"]),
      budgetStatement(ctx, {
        scope: "global",
        period: "lifetime",
        kind: "active",
        cap: c.limits.maxActiveStores,
      }),
      reservationStatement(ctx, {
        id: "active:" + s.id,
        scope: "global",
        period: "lifetime",
        kind: "active",
        units: 1,
      }),
      ctx.db
        .prepare(
          "UPDATE stores SET state='active',terms_version=?,updated_at=?,last_error=NULL,title=?,metadata_fetched_at=? WHERE id=?",
        )
        .bind(termsVersion, ctx.now(), actual.title.slice(0,300), ctx.now(), s.id),
      ctx.db.prepare("DELETE FROM mutation_guards"),
    ]);
  } catch (e) {
    throw new SelfError(
      e.message.includes("QUOTA_EXHAUSTED")
        ? "CAPACITY_UNAVAILABLE"
        : "STORE_CHANGED",
      409,
    );
  }
  return { ok: true };
}
export async function pauseStore(ctx, actor) {
  const s = await requireStore(ctx, actor);
  ensure(
    ["active", "paused", "needs_google_reconnect"].includes(s.state) &&
      s.termsVersion,
    "ACTIVATION_REQUIRED",
    409,
  );
  await ctx.db
    .prepare(
      "UPDATE stores SET state='paused',generation=generation+1,updated_at=? WHERE id=?",
    )
    .bind(ctx.now(), s.id)
    .run();
  return { ok: true };
}
export async function disconnectStore(ctx, actor, { abandoned, expiredMetadata } = {}) {
  ensure(actor.sub, "LOGIN_REQUIRED", 401);
  if (abandoned)
    ensure(Number.isFinite(abandoned.before) && abandoned.storeId, "INVALID_RETENTION_GUARD");
  const s = (await findOwnedStore(ctx, actor.sub)) ?? {
    id: "no-store:" + actor.sub,
  };
  if (abandoned && s.id !== abandoned.storeId)
    return { ok: true, state: "retained" };
  if (expiredMetadata && s.id !== expiredMetadata.storeId)
    return { ok: true, state: "retained" };
  // All credentials and bodies are local deletions; never call Google DELETE.
  const statements = [
    ctx.db
      .prepare(
        "UPDATE stores SET state='disconnected',generation=generation+1 WHERE id=?",
      )
      .bind(s.id),
    ctx.db
      .prepare("DELETE FROM google_credentials WHERE owner_sub=?")
      .bind(actor.sub),
    ctx.db
      .prepare(
        "DELETE FROM oauth_attempts WHERE owner_sub=? OR session_hash IN (SELECT token_hash FROM sessions WHERE owner_sub=?)",
      )
      .bind(actor.sub, actor.sub),
    ctx.db.prepare("DELETE FROM sessions WHERE owner_sub=?").bind(actor.sub),
    ...[
      "line_links",
      "line_checks",
      "replies",
      "review_jobs",
      "poll_cursors",
    ].map((table) =>
      ctx.db.prepare(`DELETE FROM ${table} WHERE store_id=?`).bind(s.id),
    ),
    ctx.db
      .prepare(
        "DELETE FROM notification_items WHERE notification_id IN (SELECT id FROM notification_jobs WHERE store_id=?)",
      )
      .bind(s.id),
    ctx.db.prepare("DELETE FROM notification_jobs WHERE store_id=?").bind(s.id),
    ctx.db
      .prepare("DELETE FROM location_cursors WHERE owner_sub=?")
      .bind(actor.sub),
    ctx.db
      .prepare("DELETE FROM location_candidates WHERE owner_sub=?")
      .bind(actor.sub),
    ctx.db
      .prepare(
        "UPDATE usage_reservations SET state='released' WHERE id=? AND state<>'released'",
      )
      .bind("active:" + s.id),
    ctx.db.prepare("DELETE FROM location_claims WHERE store_id=?").bind(s.id),
    ctx.db.prepare("DELETE FROM stores WHERE id=?").bind(s.id),
    ctx.db.prepare("DELETE FROM users WHERE sub=?").bind(actor.sub),
  ];
  if (abandoned) {
    // The cron's initial SELECT is only a candidate list. A concurrent activation
    // or reconnect must win over cleanup, including between the read and batch.
    statements.unshift(ctx.db.prepare(
      "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM stores WHERE id=? AND owner_sub=? AND terms_version IS NULL AND updated_at<?)",
    ).bind(abandoned.storeId, actor.sub, abandoned.before));
    statements.push(ctx.db.prepare("DELETE FROM mutation_guards"));
  }
  if (expiredMetadata) {
    // Compare the observed generation and actual API acquisition time, not a
    // generic updated_at. A concurrent reconnect/refresh must survive cleanup.
    statements.unshift(ctx.db.prepare(
      "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM stores WHERE id=? AND owner_sub=? AND generation=? AND metadata_fetched_at IS ? AND (metadata_fetched_at IS NULL OR metadata_fetched_at<=?))",
    ).bind(expiredMetadata.storeId, actor.sub, expiredMetadata.generation,
      expiredMetadata.fetchedAt, expiredMetadata.before));
    statements.push(ctx.db.prepare("DELETE FROM mutation_guards"));
  }
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    if ((abandoned || expiredMetadata) && /CHECK constraint failed: ok\s*=\s*1/.test(error.message))
      return { ok: true, state: "retained" };
    throw error;
  }
  return { ok: true, state: "disconnected" };
}
