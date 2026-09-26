import { readSession } from "./session.mjs";
import { findOwnedStore } from "./store-repository.mjs";
import { readSelfConfig } from "./config.mjs";
import { dateKeys } from "./contracts.mjs";
export async function getSelfStatus(ctx, request) {
  const c = readSelfConfig(ctx.env),
    s = await readSession(ctx, request);
  const base = {
    ok: true,
    state: "anonymous",
    notice: s?.notice ?? null,
    csrf: s?.csrf ?? null,
    registrationOpen: c.registrationEnabled,
    processingEnabled: c.processingEnabled,
    limits: c.limits,
    termsVersion: ctx.env.SELF_TERMS_VERSION ?? null,
    turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY ?? null,
    lineFriendUrl: ctx.env.SELF_LINE_FRIEND_URL ?? null,
  };
  if (!s?.owner_sub) return base;
  const store = await findOwnedStore(ctx, s.owner_sub);
  const credential = await ctx.db
    .prepare("SELECT owner_sub FROM google_credentials WHERE owner_sub=?")
    .bind(s.owner_sub)
    .first();
  if (!store)
    return {
      ...base,
      state: credential ? "google_connected" : "needs_google_reconnect",
      notice: s.notice,
    };
  const period = dateKeys(ctx.now()).month;
  const usage = await ctx.db
    .prepare(
      "SELECT kind,used,cap FROM usage_budgets WHERE scope=? AND period=?",
    )
    .bind("store:" + store.id, period)
    .all();
  const pending = await ctx.db
    .prepare(
      "SELECT count(*) n FROM replies WHERE store_id=? AND generation=? AND state='pending' AND expires_at>?",
    )
    .bind(store.id, store.generation, ctx.now())
    .first();
  const jobs = await ctx.db
    .prepare(
      "SELECT count(*) n FROM review_jobs WHERE store_id=? AND generation=? AND stage IN ('fetched','drafting','blocked','posting','post_unknown') AND payload_ciphertext IS NOT NULL",
    )
    .bind(store.id, store.generation)
    .first();
  const cursor = await ctx.db
    .prepare("SELECT page_token FROM poll_cursors WHERE store_id=?")
    .bind(store.id)
    .first();
  return {
    ...base,
    processingCount: jobs.n,
    scanIncomplete: Boolean(cursor?.page_token),
    pendingCount: pending.n,
    state: store.state,
    store: { id: store.id, title: store.title },
    lineDetected: Boolean(store.pendingLineUserId),
    lineVerified: Boolean(store.lineVerifiedAt),
    lastCheckedAt: store.lastPolledAt,
    lastError: store.lastError,
    usage: usage.results.map((x) => ({
      kind: x.kind,
      used: x.used,
      limit: x.cap,
    })),
    notice: s.notice,
  };
}
