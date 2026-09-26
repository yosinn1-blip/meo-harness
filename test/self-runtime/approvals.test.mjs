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
