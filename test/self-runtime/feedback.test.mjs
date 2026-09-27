import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withD1,
  applySchema,
  fixtureEnv,
  seedStore,
} from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import { sendSelfFeedback } from "../../worker/self-service/feedback.mjs";
test("owner gets distinct success, conflict and reapproval feedback through reply API, not paid push", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const calls = [];
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async (u, i) => {
      calls.push({ url: String(u), body: JSON.parse(i.body) });
      return Response.json({});
    },
  });
  const s = await seedStore(ctx);
  await db
    .prepare(
      "INSERT INTO replies VALUES ('ss_feedback','j',?,1,'cipher','hash','pending',?)",
    )
    .bind(s.id, ctx.now() + 10000)
    .run();
  const event = () => ({
    webhookEventId: crypto.randomUUID(),
    replyToken: crypto.randomUUID(),
    source: { type: "user", userId: "line-a" },
    postback: { data: "approve:ss_feedback" },
  });
  const cases = {
    POSTED: "投稿を確認",
    REVIEW_CONFLICT: "上書きせず",
    REAPPROVAL_REQUIRED: "もう一度",
    POST_RESULT_UNKNOWN: "未確認",
    REPLY_EXPIRED: "有効期限",
    SKIPPED: "スキップ",
  };
  for (const [code, expected] of Object.entries(cases)) {
    await sendSelfFeedback(ctx, event(), { code });
    assert.match(calls.at(-1).body.messages[0].text, new RegExp(expected));
  }
  const e = event();
  await sendSelfFeedback(
    ctx,
    { ...e, source: { type: "user", userId: "other" } },
    { code: "POSTED" },
  );
  await sendSelfFeedback(
    ctx,
    { ...e, source: { type: "group", userId: "line-a" } },
    { code: "POSTED" },
  );
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => c.url.endsWith("/reply")));
  assert.equal(
    (
      await db
        .prepare("SELECT used FROM usage_budgets WHERE kind='reply'")
        .first()
    ).used,
    6,
  );
  assert.equal(
    await db
      .prepare("SELECT used FROM usage_budgets WHERE kind='push'")
      .first(),
    null,
  );
});
test("rewrite steps reply for free and the confirmation card approves only the new revision", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const calls = [];
  const ctx = createSelfContext(fixtureEnv(db), {
    fetchImpl: async (u, i) => {
      calls.push({ url: String(u), body: JSON.parse(i.body) });
      return Response.json({});
    },
  });
  const s = await seedStore(ctx);
  await db
    .prepare("INSERT INTO replies VALUES ('ss_e','j',?,1,'cipher','hash','pending',?)")
    .bind(s.id, ctx.now() + 10000)
    .run();
  const base = (extra) => ({
    webhookEventId: crypto.randomUUID(),
    replyToken: crypto.randomUUID(),
    source: { type: "user", userId: "line-a" },
    ...extra,
  });
  await sendSelfFeedback(ctx, base({ type: "postback", postback: { data: "edit:ss_e" } }), { code: "EDIT_WAITING" });
  assert.match(calls.at(-1).body.messages[0].text, /このトークにそのまま送って/);
  assert.doesNotMatch(calls.at(-1).body.messages[0].text, /\/account/);
  await sendSelfFeedback(
    ctx,
    base({ type: "message", message: { type: "text", text: "直した文" } }),
    {
      code: "DRAFT_EDITED",
      replyId: "ss_e",
      preview: { review: { text: "口コミ", star: 4, name: "客" }, draft: "直した文", rev: 2 },
    },
  );
  const [lead, card] = calls.at(-1).body.messages;
  assert.match(lead.text, /この内容で/);
  const json = JSON.stringify(card.contents);
  assert.match(json, /approve:ss_e:r2/);
  assert.match(json, /edit:ss_e/);
  assert.match(json, /直した文/);
  // A text message from someone else never gets the preview.
  const before = calls.length;
  await sendSelfFeedback(
    ctx,
    base({ type: "message", source: { type: "user", userId: "other" }, message: { type: "text", text: "x" } }),
    { code: "DRAFT_EDITED", replyId: "ss_e", preview: { review: {}, draft: "x", rev: 3 } },
  );
  assert.equal(calls.length, before);
  assert.ok(calls.every((c) => c.url.endsWith("/reply")));
});
