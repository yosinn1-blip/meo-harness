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
import { seal, sha256, tokenKey } from "../../worker/self-service/crypto.mjs";
import {
  handleSelfPostback,
  reconcileReply,
  readOwnedReply,
  classifyCurrentReview,
} from "../../worker/self-service/approvals.mjs";
async function setup(
  t,
  { state = "active", manual = false, timeout = false } = {},
) {
  const { db } = await withD1(t);
  await applySchema(db);
  let writes = 0;
  let comment = manual ? "店主の返信" : null;
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async (input, init = {}) => {
      const u = String(input);
      if (u.includes("/token"))
        return Response.json({ access_token: "fixture" });
      if (init.method === "PUT") {
        writes++;
        comment = JSON.parse(init.body).comment;
        if (timeout) throw new Error("network after accept");
        return Response.json({});
      }
      return Response.json({
        reviewId: "r1",
        updateTime: "2026-09-26T00:00:00Z",
        ...(comment ? { reviewReply: { comment } } : {}),
      });
    },
  });
  const s = await seedStore(ctx, { state });
  await seedGoogleCredential(ctx);
  const review = { text: "元の口コミ", updateTime: "2026-09-26T00:00:00Z" };
  await db
    .prepare(
      "INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES ('j',?,'r1','v1',1,'notified',?,0,?,?)",
    )
    .bind(
      s.id,
      await seal(JSON.stringify(review), tokenKey(ctx), "job:j"),
      ctx.now(),
      ctx.now(),
    )
    .run();
  await db
    .prepare("INSERT INTO replies VALUES ('ss_r','j',?,1,?,?,'pending',?)")
    .bind(
      s.id,
      await seal("承認する返信", tokenKey(ctx), "reply:ss_r"),
      await sha256("承認する返信"),
      ctx.now() + 86400000,
    )
    .run();
  return { ctx, writes: () => writes };
}
const event = (action = "approve", userId = "line-a") => ({
  webhookEventId: crypto.randomUUID(),
  source: { type: "user", userId },
  postback: { data: action + ":ss_r" },
});
test("other LINE users and paused stores cannot approve or skip", async (t) => {
  const { ctx, writes } = await setup(t, { state: "paused" });
  assert.equal((await handleSelfPostback(ctx, event())).code, "STORE_INACTIVE");
  assert.equal(writes(), 0);
});
test("manual replies and edited reviews are never overwritten", async (t) => {
  const { ctx, writes } = await setup(t, { manual: true });
  assert.equal(
    (await handleSelfPostback(ctx, event("skip", "other"))).ok,
    false,
  );
  assert.equal(
    (await handleSelfPostback(ctx, event())).code,
    "REVIEW_CONFLICT",
  );
  assert.equal(writes(), 0);
  assert.equal(
    classifyCurrentReview({
      current: { updateTime: "v2" },
      approvedDraft: "x",
      storedReviewVersionTime: "v1",
    }),
    "conflict",
  );
});
test("parallel/re-delivered approvals post once; timeout reconciles exact remote reply", async (t) => {
  const { ctx, writes } = await setup(t, { timeout: true });
  const e = event();
  await Promise.all([handleSelfPostback(ctx, e), handleSelfPostback(ctx, e)]);
  assert.equal(writes(), 1);
  await reconcileReply(ctx, "ss_r");
  assert.equal(
    (await ctx.db.prepare("SELECT state FROM replies").first()).state,
    "posted",
  );
  await handleSelfPostback(ctx, event());
  assert.equal(writes(), 1);
});
test("full text is owner-scoped and expires", async (t) => {
  const { ctx } = await setup(t);
  assert.equal(
    (await readOwnedReply(ctx, { sub: "alice" }, "ss_r")).draftText,
    "承認する返信",
  );
  await assert.rejects(
    () => readOwnedReply(ctx, { sub: "bob" }, "ss_r"),
    (e) => e.code === "NOT_FOUND",
  );
  ctx.now = () => Date.now() + 8 * 86400000;
  await assert.rejects(() => readOwnedReply(ctx, { sub: "alice" }, "ss_r"));
});
test("Google accepts PUT then DB fails: expired lease reconciles without a second PUT", async (t) => {
  const { ctx, writes } = await setup(t);
  const db = ctx.db;
  let failures = 0;
  ctx.db = {
    prepare: db.prepare.bind(db),
    batch(statements) {
      if (writes() && failures < 2) {
        failures++;
        throw new Error("fixture write failure");
      }
      return db.batch(statements);
    },
  };
  await handleSelfPostback(ctx, event());
  assert.equal(writes(), 1);
  assert.equal(
    (await db.prepare("SELECT state FROM replies").first()).state,
    "posting",
  );
  const now = ctx.now();
  ctx.now = () => now + 61000;
  await reconcileReply(ctx, "ss_r");
  assert.equal(
    (await db.prepare("SELECT state FROM replies").first()).state,
    "posted",
  );
  assert.equal(writes(), 1);
});
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
test("an expired reconciliation cannot erase a newer posting lease with its stale GET", async (t) => {
  const { ctx, writes } = await setup(t);
  await ctx.db.prepare("UPDATE replies SET state='post_unknown'").run();
  await ctx.db.prepare("UPDATE review_jobs SET stage='post_unknown'").run();
  const original = ctx.fetchImpl;
  const aStarted = deferred(),
    aFinish = deferred(),
    putStarted = deferred(),
    putFinish = deferred();
  let gets = 0;
  let now = ctx.now();
  ctx.now = () => now;
  ctx.fetchImpl = async (u, i = {}) => {
    if (String(u).includes("/reviews/") && i.method !== "PUT" && ++gets === 1) {
      aStarted.resolve();
      await aFinish.promise;
      return Response.json({ updateTime: "2026-09-26T00:00:00Z" });
    }
    if (i.method === "PUT") {
      putStarted.resolve();
      await putFinish.promise;
    }
    return original(u, i);
  };
  const a = reconcileReply(ctx, "ss_r");
  await aStarted.promise;
  now += 61000;
  await reconcileReply(ctx, "ss_r");
  const c = handleSelfPostback(ctx, event());
  await putStarted.promise;
  try {
    aFinish.resolve();
    await a;
    assert.equal(
      (await ctx.db.prepare("SELECT state FROM replies").first()).state,
      "posting",
    );
    assert.ok(
      (await ctx.db.prepare("SELECT lease_id FROM review_jobs").first())
        .lease_id,
    );
  } finally {
    aFinish.resolve();
    putFinish.resolve();
    await c;
  }
  assert.equal(writes(), 1);
  assert.equal(
    (await ctx.db.prepare("SELECT state FROM replies").first()).state,
    "posted",
  );
});
test("obsolete unknown replies cannot starve a current recoverable reply in scheduled reconciliation", async (t) => {
  const { ctx } = await setup(t);
  await ctx.db.prepare("UPDATE replies SET state='post_unknown'").run();
  await ctx.db
    .prepare("UPDATE review_jobs SET stage='post_unknown',next_attempt_at=0")
    .run();
  const current = await ctx.db.prepare("SELECT * FROM replies").first();
  for (let i = 0; i < 5; i++) {
    await ctx.db
      .prepare(
        "INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) SELECT ?,store_id,?,'old',0,'post_unknown',payload_ciphertext,0,created_at,updated_at FROM review_jobs WHERE id='j'",
      )
      .bind("old" + i, "old" + i)
      .run();
    await ctx.db
      .prepare(
        "INSERT INTO replies SELECT ?,?,store_id,0,draft_ciphertext,draft_hash,'post_unknown',expires_at FROM replies WHERE id='ss_r'",
      )
      .bind("ss_old" + i, "old" + i)
      .run();
  }
  await ctx.db.prepare("DELETE FROM replies WHERE id='ss_r'").run();
  await ctx.db
    .prepare("INSERT INTO replies VALUES (?,?,?,?,?,?,?,?)")
    .bind(...Object.values(current))
    .run();
  const { runSelfScheduled } = await import(
    "../../worker/self-service/scheduled.mjs"
  );
  await runSelfScheduled(ctx);
  assert.equal(
    (
      await ctx.db
        .prepare("SELECT stage FROM review_jobs WHERE id='old0'")
        .first()
    ).stage,
    "cancelled",
  );
  assert.equal(
    (await ctx.db.prepare("SELECT state FROM replies WHERE id='ss_r'").first())
      .state,
    "pending",
  );
});
