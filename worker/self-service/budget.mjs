import { SelfError, ensure } from "./errors.mjs";
import { readSelfConfig } from "./config.mjs";
import { dateKeys } from "./contracts.mjs";
// Registration IDs change on disconnect; the actual GBP location does not.
export function draftBudgetScope(store) {
  ensure(/^locations\/\d+$/.test(store?.locationId ?? ""), "INVALID_LOCATION");
  return "location:" + store.locationId;
}
export function budgetStatement(ctx, { scope, period, kind, cap }) {
  return ctx.db
    .prepare(
      "INSERT INTO usage_budgets(scope,period,kind,cap,used) VALUES (?,?,?,?,0) ON CONFLICT(scope,period,kind) DO UPDATE SET cap=excluded.cap",
    )
    .bind(scope, period, kind, cap);
}
export function reservationStatement(ctx, { id, scope, period, kind, units }) {
  ensure(
    typeof id === "string" && Number.isSafeInteger(units) && units > 0,
    "INVALID_RESERVATION",
  );
  return ctx.db
    .prepare(
      "INSERT INTO usage_reservations VALUES (?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(id, scope, period, kind, units, ctx.now());
}
export async function reserveUsage(ctx, args) {
  return reserveUsageBatch(ctx, [args]);
}
export async function reserveUsageBatch(
  ctx,
  args,
  { before = [], after = [] } = {},
) {
  try {
    await ctx.db.batch([
      ...before,
      ...args.map((a) => reservationStatement(ctx, a)),
      ...after,
    ]);
    return { ok: true, code: "RESERVED" };
  } catch (e) {
    if (e.message.includes("RESERVATION_RELEASED"))
      return { ok: false, code: "RESERVATION_RELEASED" };
    if (
      e.message.includes("QUOTA_EXHAUSTED") ||
      /CHECK constraint failed/i.test(e.message)
    )
      return { ok: false, code: "QUOTA_EXHAUSTED" };
    if (e.message.includes("RESERVATION_MISMATCH"))
      throw new SelfError("RESERVATION_MISMATCH", 409);
    throw e;
  }
}
export async function settleUsage(ctx, id, outcome) {
  ensure(
    ["committed", "released", "uncertain"].includes(outcome),
    "INVALID_RESERVATION",
  );
  await ctx.db
    .prepare(
      "UPDATE usage_reservations SET state=? WHERE id IN (?,?) AND state<>'released' AND (state<>'committed' OR ?='released' AND kind='active')",
    )
    .bind(outcome, id, id + ":provider", outcome)
    .run();
}
export function remainingPushBudget({
  localRemaining,
  providerRemaining,
  legacyReserve,
}) {
  if (
    !Number.isFinite(providerRemaining) ||
    !Number.isFinite(localRemaining) ||
    !Number.isFinite(legacyReserve)
  )
    return 0;
  return Math.max(
    0,
    Math.min(localRemaining, providerRemaining - legacyReserve),
  );
}
export async function reservePush(ctx, { id, storeId }) {
  const c = readSelfConfig(ctx.env),
    period = dateKeys(ctx.now()).month;
  if (!c.processingEnabled || c.limits.pushes === 0)
    return { ok: false, code: "PROCESSING_CLOSED" };
  const prior = await ctx.db
    .prepare("SELECT state,period FROM usage_reservations WHERE id=?")
    .bind(id)
    .first();
  if (prior?.state === "committed") return { ok: true, code: "RESERVED" };
  if (prior?.state === "released")
    return { ok: false, code: "RESERVATION_RELEASED" };
  if (prior && prior.period !== period)
    return { ok: false, code: "QUOTA_PERIOD_CHANGED" };
  let consumed, providerCap;
  try {
    const headers = {
      Authorization: "Bearer " + ctx.env.LINE_CHANNEL_ACCESS_TOKEN,
    };
    const quota = await ctx.fetchImpl(
      "https://api.line.me/v2/bot/message/quota",
      { headers, signal: AbortSignal.timeout(10000) },
    );
    const usage = await ctx.fetchImpl(
      "https://api.line.me/v2/bot/message/quota/consumption",
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (!quota.ok || !usage.ok) return { ok: false, code: "QUOTA_UNKNOWN" };
    const q = await quota.json();
    consumed = (await usage.json()).totalUsage;
    const total =
      q.type === "none"
        ? Number.MAX_SAFE_INTEGER
        : q.type === "limited"
          ? q.value
          : null;
    if (
      !Number.isSafeInteger(consumed) ||
      consumed < 0 ||
      !Number.isSafeInteger(total) ||
      total < 0
    )
      return { ok: false, code: "QUOTA_UNKNOWN" };
    providerCap = Math.max(0, total - c.limits.legacyReserve);
    if (consumed >= providerCap) return { ok: false, code: "QUOTA_EXHAUSTED" };
  } catch {
    return { ok: false, code: "QUOTA_UNKNOWN" };
  }
  // Monotonic shadow usage includes accepted local calls even before LINE's
  // counter catches up, plus all uncertain/in-flight local reservations.
  // Conservative overlap can hold capacity; never reclaim an unknown send.
  const before = [
    budgetStatement(ctx, {
      scope: "channel",
      period,
      kind: "push",
      cap: c.limits.pushes,
    }),
    ctx.db
      .prepare(
        "INSERT INTO usage_budgets(scope,period,kind,cap,used) VALUES ('channel',?,'provider_push',?,?) ON CONFLICT(scope,period,kind) DO UPDATE SET cap=excluded.cap,used=MAX(usage_budgets.used,excluded.used+(SELECT COALESCE(SUM(units),0) FROM usage_reservations WHERE scope='channel' AND period=? AND kind='push' AND state IN ('reserved','uncertain')))",
      )
      .bind(period, providerCap, consumed, period),
    ctx.db
      .prepare(
        "INSERT INTO mutation_guards SELECT NOT EXISTS(SELECT 1 FROM usage_budgets WHERE scope='channel' AND period=? AND kind IN ('push','provider_push') AND used>cap)",
      )
      .bind(period),
  ];
  return reserveUsageBatch(
    ctx,
    [
      { id, scope: "channel", period, kind: "push", units: 1 },
      {
        id: id + ":provider",
        scope: "channel",
        period,
        kind: "provider_push",
        units: 1,
      },
    ],
    { before, after: [ctx.db.prepare("DELETE FROM mutation_guards")] },
  );
}
export async function sendReservedPush(ctx, { id, to, messages, retryKey }) {
  const reservation = await ctx.db
    .prepare("SELECT state FROM usage_reservations WHERE id=?")
    .bind(id)
    .first();
  ensure(
    reservation && reservation.state !== "released",
    "RESERVATION_REQUIRED",
    409,
  );
  if (reservation.state === "committed") return { accepted: true };
  let response;
  try {
    response = await ctx.fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ctx.env.LINE_CHANNEL_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    await settleUsage(ctx, id, "uncertain");
    throw new SelfError("LINE_RESULT_UNKNOWN", 502);
  }
  if (
    response.ok ||
    (response.status === 409 &&
      response.headers.get("x-line-accepted-request-id"))
  ) {
    await settleUsage(ctx, id, "committed");
    return {
      accepted: true,
      requestId:
        response.headers.get("x-line-accepted-request-id") ??
        response.headers.get("x-line-request-id"),
    };
  }
  await settleUsage(ctx, id, response.status >= 500 ? "uncertain" : "released");
  throw new SelfError(
    response.status >= 500
      ? "LINE_RESULT_UNKNOWN"
      : response.status === 429
        ? "LINE_RETRY_REQUIRED"
        : "LINE_SEND_FAILED",
    502,
  );
}
