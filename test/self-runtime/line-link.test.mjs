import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withD1,
  applySchema,
  fixtureEnv,
  seedStore,
} from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import {
  issueLineCode,
  consumeLineCode,
  verifyLinePin,
} from "../../worker/self-service/line-link.mjs";
import { sha256, hmac } from "../../worker/self-service/crypto.mjs";
const actor = { sub: "alice", sessionHash: "session-a" };
const event = (code, userId = "line-a") => ({
  source: { type: "user", userId },
  message: { text: code },
});
test("codes are single-use even with concurrent LINE events; reissue invalidates old code", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext(fixtureEnv(db));
  await seedStore(ctx, { state: "location_selected", lineUserId: null });
  const a = await issueLineCode(ctx, actor);
  assert.match(a.code, /^MEOS-[A-HJ-NP-Z2-9]{12}$/);
  const out = await Promise.allSettled([
    consumeLineCode(ctx, event(a.code)),
    consumeLineCode(ctx, event(a.code, "other")),
  ]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  const b = await issueLineCode(ctx, actor);
  await assert.rejects(() => consumeLineCode(ctx, event(a.code)));
  await consumeLineCode(ctx, event(b.code));
  const store = await db.prepare("SELECT * FROM stores").first();
  assert.equal(store.state, "line_pending");
  assert.equal(store.line_user_id, null);
});
test("PIN is session-bound, max five attempts, single-use and expires", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  let now = 10000;
  const ctx = createSelfContext(fixtureEnv(db), { now: () => now });
  const s = await seedStore(ctx, { state: "line_pending" });
  await db
    .prepare(
      "UPDATE stores SET pending_line_user_id='target',line_verified_at=NULL WHERE id=?",
    )
    .bind(s.id)
    .run();
  async function pin() {
    await db
      .prepare("INSERT OR REPLACE INTO line_checks VALUES (?,?,?,?,?,?)")
      .bind(
        s.id,
        await hmac("123456", ctx.env.SELF_RATE_KEY + ":" + s.id),
        1,
        actor.sessionHash,
        0,
        now + 300000,
      )
      .run();
  }
  await pin();
  await assert.rejects(
    () => verifyLinePin(ctx, { ...actor, sessionHash: "other" }, "123456"),
    (e) => e.code === "PIN_INVALID",
  );
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      () => verifyLinePin(ctx, actor, "000000"),
      (e) => e.code === "PIN_INVALID",
    );
  await assert.rejects(
    () => verifyLinePin(ctx, actor, "123456"),
    (e) => e.code === "PIN_INVALID",
  );
  await pin();
  await verifyLinePin(ctx, actor, "123456");
  assert.equal(
    (await db.prepare("SELECT line_user_id FROM stores").first()).line_user_id,
    "target",
  );
  await assert.rejects(() => verifyLinePin(ctx, actor, "123456"));
  await pin();
  now += 300000;
  await assert.rejects(() => verifyLinePin(ctx, actor, "123456"));
});
