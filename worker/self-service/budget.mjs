import { SelfError, ensure } from "./errors.mjs";
import { readSelfConfig } from "./config.mjs";
import { dateKeys } from "./contracts.mjs";
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
export async function reserveUsageBatch(ctx, args) {
  try {
    await ctx.db.batch(args.map((a) => reservationStatement(ctx, a)));
    return { ok: true, code: "RESERVED" };
  } catch (e) {
    if (e.message.includes("RESERVATION_RELEASED"))
      return { ok: false, code: "RESERVATION_RELEASED" };
    if (e.message.includes("QUOTA_EXHAUSTED"))
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
      "UPDATE usage_reservations SET state=? WHERE id=? AND state<>'released' AND (state<>'committed' OR ?='released' AND kind='active')",
    )
    .bind(outcome, id, outcome)
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
  const c = readSelfConfig(ctx.env);
  if (!c.processingEnabled || c.limits.pushes === 0)
    return { ok: false, code: "PROCESSING_CLOSED" };
  const period = dateKeys(ctx.now()).month;
  await budgetStatement(ctx, {
    scope: "channel",
    period,
    kind: "push",
    cap: c.limits.pushes,
  }).run();
  const current = await ctx.db
    .prepare(
      "SELECT used,cap FROM usage_budgets WHERE scope='channel' AND period=? AND kind='push'",
    )
    .bind(period)
    .first();
  const prior = await ctx.db
    .prepare("SELECT state,period FROM usage_reservations WHERE id=?")
    .bind(id)
    .first();
  if (prior?.state === "committed") return { ok: true, code: "RESERVED" };
  if (prior?.state === "released")
    return { ok: false, code: "RESERVATION_RELEASED" };
  if (prior && prior.period !== period)
    return { ok: false, code: "QUOTA_PERIOD_CHANGED" };
  if (!prior && current.used >= current.cap)
    return { ok: false, code: "QUOTA_EXHAUSTED" };
  try {
    const headers = {
      Authorization: "Bearer " + ctx.env.LINE_CHANNEL_ACCESS_TOKEN,
    };
    const quota = await ctx.fetchImpl(
      "https://api.line.me/v2/bot/message/quota",
      { headers, signal: AbortSignal.timeout(10000) },
    );
    const consumed = await ctx.fetchImpl(
      "https://api.line.me/v2/bot/message/quota/consumption",
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (!quota.ok || !consumed.ok) return { ok: false, code: "QUOTA_UNKNOWN" };
    const q = await quota.json(),
      used = (await consumed.json()).totalUsage;
    const remaining =
      q.type === "none"
        ? Number.MAX_SAFE_INTEGER
        : q.type === "limited"
          ? q.value - used
          : null;
    if (
      !Number.isFinite(used) ||
      remainingPushBudget({
        localRemaining: current.cap - current.used + (prior ? 1 : 0),
        providerRemaining: remaining,
        legacyReserve: c.limits.legacyReserve,
      }) < 1
    )
      return { ok: false, code: "QUOTA_EXHAUSTED" };
  } catch {
    return { ok: false, code: "QUOTA_UNKNOWN" };
  }
  return reserveUsage(ctx, {
    id,
    scope: "channel",
    period,
    kind: "push",
    units: 1,
  });
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
    response.status >= 500 ? "LINE_RESULT_UNKNOWN" : "LINE_SEND_FAILED",
    502,
  );
}
