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
  pollSelfStore,
  processSelfJobs,
} from "../../worker/self-service/ingestion.mjs";
import { sendSelfDigest } from "../../worker/self-service/notifications.mjs";
import { pauseStore } from "../../worker/self-service/lifecycle.mjs";
async function setup(t, { drafts = "1", timeout = false } = {}) {
  const { db } = await withD1(t);
  await applySchema(db);
  const calls = { ai: 0, push: [], pages: [] };
  let pushTimeout = timeout;
  const now = Date.parse("2026-09-27T00:00:00Z");
  const ctx = createSelfContext(
    fixtureEnv(db, { SELF_MONTHLY_DRAFT_LIMIT: drafts }),
    {
      now: () => now,
      fetchImpl: async (input, init = {}) => {
        const u = new URL(input);
        if (u.hostname === "oauth2.googleapis.com")
          return Response.json({ access_token: "fixture" });
        if (u.hostname === "mybusiness.googleapis.com") {
          calls.pages.push(u.searchParams.get("pageToken"));
          const page = Number(u.searchParams.get("pageToken") ?? 0);
          return Response.json({
            reviews: [
              {
                reviewId: "r" + page,
                comment: "良かったです",
                starRating: "FIVE",
                createTime: "2026-09-26T00:00:00Z",
                updateTime: "2026-09-26T00:00:00Z",
              },
            ],
            ...(page === 0 ? { nextPageToken: "1" } : {}),
          });
        }
        if (u.hostname === "api.groq.com") {
          calls.ai++;
          return Response.json({
            choices: [
              { message: { content: "ご来店ありがとうございました。" } },
            ],
            usage: { total_tokens: 10 },
          });
        }
        if (u.pathname.endsWith("/quota"))
          return Response.json({ type: "limited", value: 200 });
        if (u.pathname.endsWith("/consumption"))
          return Response.json({ totalUsage: 0 });
        if (u.pathname.endsWith("/push")) {
          calls.push.push({
            key: init.headers["X-Line-Retry-Key"],
            body: init.body,
          });
          if (pushTimeout) {
            pushTimeout = false;
            throw new Error("network");
          }
          return new Response(null, {
            status: 409,
            headers: { "x-line-accepted-request-id": "accepted" },
          });
        }
        throw new Error("UNEXPECTED_PROVIDER");
      },
    },
  );
  const store = await seedStore(ctx);
  await seedGoogleCredential(ctx);
  return { ctx, store, calls };
}
test("poll persists all pages, deduplicates; zero draft budget keeps backlog and calls no AI", async (t) => {
  const { ctx, store, calls } = await setup(t, { drafts: "0" });
  await pollSelfStore(ctx, store.id);
  await pollSelfStore(ctx, store.id);
  assert.equal(
    (await ctx.db.prepare("SELECT count(*) n FROM review_jobs").first()).n,
    2,
  );
  await processSelfJobs(ctx, { limit: 5 });
  assert.equal(calls.ai, 0);
  assert.equal(
    (
      await ctx.db
        .prepare("SELECT count(*) n FROM review_jobs WHERE stage='fetched'")
        .first()
    ).n,
    2,
  );
  assert.deepEqual(calls.pages.slice(0, 2), [null, "1"]);
});
test("one draft unit creates one reply and retains the rest; LINE timeout retries exact payload/key", async (t) => {
  const { ctx, store, calls } = await setup(t, { timeout: true });
  await pollSelfStore(ctx, store.id);
  await processSelfJobs(ctx, { limit: 5 });
  assert.equal(calls.ai, 1);
  assert.equal(
    (await ctx.db.prepare("SELECT count(*) n FROM replies").first()).n,
    1,
  );
  await assert.rejects(
    () => sendSelfDigest(ctx, store.id),
    (e) => e.code === "LINE_RESULT_UNKNOWN",
  );
  await sendSelfDigest(ctx, store.id);
  assert.equal(calls.push.length, 2);
  assert.deepEqual(calls.push[0], calls.push[1]);
  assert.equal(
    (
      await ctx.db
        .prepare("SELECT count(*) n FROM review_jobs WHERE stage='notified'")
        .first()
    ).n,
    1,
  );
  await sendSelfDigest(ctx, store.id);
  assert.equal(calls.push.length, 2);
});
test("paused store performs no provider calls and leaves work intact", async (t) => {
  const { ctx, store, calls } = await setup(t);
  await pollSelfStore(ctx, store.id);
  await pauseStore(ctx, { sub: "alice" });
  const before = calls.pages.length;
  await pollSelfStore(ctx, store.id);
  await processSelfJobs(ctx, { limit: 5 });
  await sendSelfDigest(ctx, store.id);
  assert.equal(calls.ai, 0);
  assert.equal(calls.push.length, 0);
  assert.equal(calls.pages.length, before);
});
test("unsent notification snapshot expires with original review bodies after seven days", async (t) => {
  const { ctx, store } = await setup(t);
  await pollSelfStore(ctx, store.id);
  await processSelfJobs(ctx);
  ctx.env.SELF_MONTHLY_PUSH_LIMIT = "0";
  await sendSelfDigest(ctx, store.id);
  const job = await ctx.db.prepare("SELECT * FROM notification_jobs").first();
  assert.ok(job.payload_ciphertext);
  assert.equal(job.first_attempt_at, null);
  const before = ctx.now();
  ctx.now = () => before + 8 * 86400000;
  const { purgeExpired } = await import(
    "../../worker/self-service/retention.mjs"
  );
  await purgeExpired(ctx);
  const expired = await ctx.db
    .prepare("SELECT * FROM notification_jobs")
    .first();
  assert.equal(expired.payload_ciphertext, null);
  assert.equal(expired.state, "expired");
});
test("last-attempt crashed drafting lease becomes blocked instead of remaining stuck", async (t) => {
  const { ctx, store } = await setup(t);
  await pollSelfStore(ctx, store.id);
  await ctx.db
    .prepare("UPDATE review_jobs SET stage='drafting',attempts=5,lease_until=?")
    .bind(ctx.now() - 1)
    .run();
  await processSelfJobs(ctx);
  const jobs = await ctx.db.prepare("SELECT stage FROM review_jobs").all();
  assert.ok(jobs.results.every((x) => x.stage === "blocked"));
});
test("AI response followed by DB failure retains consumption and cannot exceed the cap on retry", async (t) => {
  const { ctx, store, calls } = await setup(t);
  await pollSelfStore(ctx, store.id);
  const db = ctx.db;
  let failed = false;
  ctx.db = {
    prepare: db.prepare.bind(db),
    batch(statements) {
      if (calls.ai && !failed) {
        failed = true;
        throw new Error("fixture DB failure");
      }
      return db.batch(statements);
    },
  };
  await processSelfJobs(ctx);
  const now = ctx.now();
  ctx.now = () => now + 61000;
  await processSelfJobs(ctx);
  assert.equal(calls.ai, 1);
  assert.equal(
    (
      await db
        .prepare("SELECT used FROM usage_budgets WHERE kind='draft'")
        .first()
    ).used,
    1,
  );
});
test("LINE accepted then notification DB update fails: retry sends no second push", async (t) => {
  const { ctx, store, calls } = await setup(t);
  await pollSelfStore(ctx, store.id);
  await processSelfJobs(ctx);
  const db = ctx.db;
  let failed = false;
  ctx.db = {
    prepare: db.prepare.bind(db),
    batch(statements) {
      if (calls.push.length && !failed) {
        failed = true;
        throw new Error("fixture DB failure");
      }
      return db.batch(statements);
    },
  };
  await assert.rejects(() => sendSelfDigest(ctx, store.id));
  await sendSelfDigest(ctx, store.id);
  assert.equal(calls.push.length, 1);
  assert.equal(
    (await db.prepare("SELECT state FROM notification_jobs").first()).state,
    "accepted",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT used FROM usage_budgets WHERE kind='push'")
        .first()
    ).used,
    1,
  );
});
test("more than 50 reviews resumes a bounded scan; old and already answered reviews are excluded", async (t) => {
  const { ctx, store } = await setup(t, { drafts: "0" });
  const fallback = ctx.fetchImpl;
  const pages = [];
  ctx.fetchImpl = async (input, init) => {
    const u = new URL(input);
    if (u.hostname !== "mybusiness.googleapis.com")
      return fallback(input, init);
    const p = Number(u.searchParams.get("pageToken") ?? 0);
    pages.push(p);
    return Response.json({
      reviews: Array.from({ length: 50 }, (_, i) => ({
        reviewId: "r" + (p * 50 + i),
        comment: "架空口コミ",
        starRating: "FIVE",
        createTime:
          p === 0 && i === 0 ? "2026-01-01T00:00:00Z" : "2026-09-26T00:00:00Z",
        updateTime: "2026-09-26T00:00:00Z",
        ...(p === 0 && i === 1 ? { reviewReply: { comment: "既存返信" } } : {}),
      })),
      ...(p < 2 ? { nextPageToken: String(p + 1) } : {}),
    });
  };
  await pollSelfStore(ctx, store.id);
  assert.deepEqual(pages, [0, 1]);
  assert.equal(
    (await ctx.db.prepare("SELECT count(*) n FROM review_jobs").first()).n,
    98,
  );
  await pollSelfStore(ctx, store.id);
  assert.deepEqual(pages, [0, 1, 2]);
  assert.equal(
    (await ctx.db.prepare("SELECT count(*) n FROM review_jobs").first()).n,
    148,
  );
});
