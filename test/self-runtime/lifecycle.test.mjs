import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withD1,
  applySchema,
  fixtureEnv,
  seedStore,
} from "../support/self-runtime.mjs";
import { seedGoogleCredential } from "../support/self-google.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import {
  activateStore,
  pauseStore,
  disconnectStore,
} from "../../worker/self-service/lifecycle.mjs";
import { purgeExpired } from "../../worker/self-service/retention.mjs";
const actor = { sub: "alice" };
test("activation confirms rights and terms, pause blocks future work, disconnect erases secrets not Google replies", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const calls = [];
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async (u, i) => {
      calls.push(i?.method ?? "GET");
      return Response.json(
        String(u).includes("/token")
          ? { access_token: "fixture" }
          : String(u).includes('mybusinessaccountmanagement') ? {name:'accounts/1'}
          : { name: "locations/2", title: "店" },
      );
    },
  });
  const s = await seedStore(ctx, { state: "line_verified" });
  await seedGoogleCredential(ctx);
  await assert.rejects(() =>
    activateStore(ctx, actor, { confirmed: false, termsVersion: "fixture-v1" }),
  );
  await activateStore(ctx, actor, {
    confirmed: true,
    termsVersion: "fixture-v1",
  });
  await pauseStore(ctx, actor);
  const paused = await db.prepare("SELECT * FROM stores").first();
  assert.equal(paused.state, "paused");
  assert.ok(paused.generation > 1);
  await activateStore(ctx, actor, {
    confirmed: true,
    termsVersion: "fixture-v1",
  });
  assert.equal(
    (
      await db
        .prepare("SELECT used FROM usage_budgets WHERE kind='active'")
        .first()
    ).used,
    1,
  );
  await disconnectStore(ctx, actor);
  assert.equal(
    await db.prepare("SELECT * FROM google_credentials").first(),
    null,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT used FROM usage_budgets WHERE kind='active'")
        .first()
    ).used,
    0,
  );
  assert.ok(!calls.includes("DELETE"));
});
test("unfinished credentials expire after inactivity and audit after 30 days", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  let now = 1000;
  const ctx = createSelfContext(fixtureEnv(db), { now: () => now });
  await seedGoogleCredential(ctx);
  await db
    .prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)")
    .bind("a", null, null, "test", "OK", 0)
    .run();
  now += 31 * 86400000;
  await purgeExpired(ctx);
  assert.equal(
    await db.prepare("SELECT * FROM google_credentials").first(),
    null,
  );
  assert.equal(await db.prepare("SELECT * FROM audit_events").first(), null);
});
test("unfinished Google connection can be explicitly disconnected without selecting a store", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await seedGoogleCredential(ctx);
  const result = await disconnectStore(ctx, actor);
  assert.equal(result.state, "disconnected");
  assert.equal(
    await db.prepare("SELECT * FROM google_credentials").first(),
    null,
  );
  assert.equal(await db.prepare("SELECT * FROM users").first(), null);
});
test("pausing unfinished setup cannot bypass the 24 hour cleanup", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await seedStore(ctx, { state: "line_pending" });
  await assert.rejects(
    () => pauseStore(ctx, actor),
    (e) => e.code === "ACTIVATION_REQUIRED",
  );
});
test("first activation tells the operator on LINE once; resume and failures stay silent", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const pushes = [];
  let pushFails = false;
  const env = { ...fixtureEnv(db), SELF_OPERATOR_LINE_USER_ID: "U" + "0".repeat(32) };
  const ctx = createSelfContext(env, {
    fetchImpl: async (u, i) => {
      if (String(u).includes("api.line.me/v2/bot/message/push")) {
        pushes.push(JSON.parse(i.body));
        if (pushFails) throw new Error("line down");
        return Response.json({});
      }
      return Response.json(
        String(u).includes("/token")
          ? { access_token: "fixture" }
          : String(u).includes("mybusinessaccountmanagement") ? { name: "accounts/1" }
          : { name: "locations/2", title: "店" },
      );
    },
  });
  await seedStore(ctx, { state: "line_verified" });
  await seedGoogleCredential(ctx);
  await activateStore(ctx, actor, { confirmed: true, termsVersion: "fixture-v1" });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, env.SELF_OPERATOR_LINE_USER_ID);
  assert.match(pushes[0].messages[0].text, /店/);
  assert.match(pushes[0].messages[0].text, /1\/\d+店舗/);
  await pauseStore(ctx, actor);
  await activateStore(ctx, actor, { confirmed: true, termsVersion: "fixture-v1" });
  assert.equal(pushes.length, 1, "resuming a paused store is not a new registration");
  await db.prepare("UPDATE stores SET state='line_verified'").run();
  pushFails = true;
  await activateStore(ctx, actor, { confirmed: true, termsVersion: "fixture-v1" });
  assert.equal((await db.prepare("SELECT state FROM stores").first()).state, "active");
});
