import { test } from "node:test";
import assert from "node:assert/strict";
import { withD1, applySchema, fixtureEnv } from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import {
  reserveUsage,
  reserveUsageBatch,
  settleUsage,
  remainingPushBudget,
  reservePush,
} from "../../worker/self-service/budget.mjs";
test("last budget unit cannot be reserved twice; retry is idempotent and release happens once", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await db
    .prepare("INSERT INTO usage_budgets VALUES (?,?,?,?,?)")
    .bind("channel", "2026-09", "push", 1, 0)
    .run();
  const arg = (id) => ({
    id,
    scope: "channel",
    period: "2026-09",
    kind: "push",
    units: 1,
  });
  const results = await Promise.all(
    ["a", "b"].map((id) => reserveUsage(ctx, arg(id))),
  );
  assert.equal(results.filter((x) => x.ok).length, 1);
  const id = results[0].ok ? "a" : "b";
  assert.equal((await reserveUsage(ctx, arg(id))).ok, true);
  await assert.rejects(
    () => reserveUsage(ctx, { ...arg(id), units: 2 }),
    (e) => e.code === "RESERVATION_MISMATCH",
  );
  await settleUsage(ctx, id, "uncertain");
  assert.equal(
    (await db.prepare("SELECT used FROM usage_budgets").first()).used,
    1,
  );
  await settleUsage(ctx, id, "released");
  await settleUsage(ctx, id, "released");
  assert.equal(
    (await db.prepare("SELECT used FROM usage_budgets").first()).used,
    0,
  );
});
test("multi-scope failure rolls all reservations back", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await db.batch(
    ["a", "b"].map((scope, i) =>
      db
        .prepare("INSERT INTO usage_budgets VALUES (?,?,?,?,?)")
        .bind(scope, "m", "push", i ? 0 : 1, 0),
    ),
  );
  const r = await reserveUsageBatch(
    ctx,
    ["a", "b"].map((scope) => ({
      id: scope,
      scope,
      period: "m",
      kind: "push",
      units: 1,
    })),
  );
  assert.equal(r.ok, false);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM usage_reservations").first()).n,
    0,
  );
});
test("provider quota consumed elsewhere or unknown must stop push", async (t) => {
  assert.equal(
    remainingPushBudget({
      localRemaining: 10,
      providerRemaining: 2,
      legacyReserve: 2,
    }),
    0,
  );
  assert.equal(
    remainingPushBudget({
      localRemaining: 10,
      providerRemaining: null,
      legacyReserve: 0,
    }),
    0,
  );
  assert.equal(
    remainingPushBudget({
      localRemaining: 10,
      providerRemaining: 5,
      legacyReserve: 2,
    }),
    3,
  );
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async () => Response.json({}, { status: 500 }),
  });
  assert.equal((await reservePush(ctx, { id: "p", storeId: "s" })).ok, false);
});
test("a released item rolls back new reservations in the same atomic batch", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await db
    .prepare("INSERT INTO usage_budgets VALUES (?,?,?,?,?)")
    .bind("s", "m", "push", 3, 0)
    .run();
  const a = (id) => ({ id, scope: "s", period: "m", kind: "push", units: 1 });
  await reserveUsage(ctx, a("old"));
  await settleUsage(ctx, "old", "released");
  const r = await reserveUsageBatch(ctx, [a("new"), a("old")]);
  assert.equal(r.ok, false);
  assert.equal(
    await db
      .prepare("SELECT id FROM usage_reservations WHERE id='new'")
      .first(),
    null,
  );
});
test("uncertain LINE retries recheck the shared provider quota", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  let used = 0;
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async (u) =>
      Response.json(
        String(u).endsWith("/consumption")
          ? { totalUsage: used }
          : { type: "limited", value: 3 },
      ),
  });
  assert.equal((await reservePush(ctx, { id: "same", storeId: "s" })).ok, true);
  await settleUsage(ctx, "same", "uncertain");
  used = 3;
  assert.equal(
    (await reservePush(ctx, { id: "same", storeId: "s" })).ok,
    false,
  );
});
