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
    POSTED: "投稿されたことを確認",
    REVIEW_CONFLICT: "上書きせず",
    REAPPROVAL_REQUIRED: "もう一度",
    POST_RESULT_UNKNOWN: "まだ確認できていません",
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
  await sendSelfFeedback(ctx, base({ type: "postback", postback: { data: "edit:ss_e" } }), { code: "EDIT_WAITING", currentDraft: "AIの返信案" });
  assert.equal(calls.at(-1).body.messages.length, 2);
  assert.equal(calls.at(-1).body.messages[0].text, "AIの返信案");
  const guidance = calls.at(-1).body.messages[1].text;
  assert.match(guidance, /いまの返信案/);
  assert.match(guidance, /このトークに1通で送って/);
  assert.match(guidance, /送っただけでは投稿されません/);
  assert.match(guidance, /30分以内/);
  assert.doesNotMatch(guidance, /\/account/);
  await sendSelfFeedback(ctx, base({type: "postback", postback:{data:"edit:ss_e"}}), {code:"EDIT_WAITING"});
  assert.equal(calls.at(-1).body.messages.length, 1, "legacy result without currentDraft");
  const count = calls.length;
  await sendSelfFeedback(ctx, base({type:"postback", postback:{data:"edit:ss_e"}, source:{type:"user",userId:"other"}}), {code:"EDIT_WAITING", currentDraft:"AIの返信案"});
  assert.equal(calls.length, count, "never reveal draft to another user");
  await sendSelfFeedback(ctx, base({type:"message"}), {code:"EDIT_EXPIRED",replyId:"ss_e"});
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).body.messages.length, 1);
  assert.match(calls.at(-1).body.messages[0].text, /30分が過ぎた/);
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
  assert.match(card.contents.header.contents[0].text, /編集した返信案の確認/);
  assert.match(json, /編集する/);
  assert.doesNotMatch(json, /書き直す/);
  assert.match(json, /"label":"送信"/);
  assert.doesNotMatch(json, /承認して送信/);
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

test('LINE-09: pending and uncertain results explain the next step without jargon', async t => {
  const {db} = await withD1(t); await applySchema(db);
  const calls = [];
  const ctx = createSelfContext(fixtureEnv(db), {fetchImpl: async (u, i) => {
    calls.push(JSON.parse(i.body)); return Response.json({});
  }});
  const s = await seedStore(ctx);
  await db.prepare("INSERT INTO replies VALUES ('ss_words','j',?,1,'cipher','hash','pending',?)").bind(s.id, ctx.now()+10000).run();
  for (const code of ['POST_PENDING', 'ALREADY_HANDLED', 'POST_CHECK_FAILED', 'POST_RESULT_UNKNOWN']) {
    await sendSelfFeedback(ctx, {webhookEventId: crypto.randomUUID(), replyToken: 'fixture', source:{type:'user',userId:'line-a'}, postback:{data:'approve:ss_words'}}, {code});
    const text = calls.at(-1).messages[0].text;
    assert.doesNotMatch(text, /アカウント画面|照合|連打/);
    assert.match(text, /最近の返信結果/);
    assert.ok(text.endsWith('\nhttps://meo.test/account'));
  }
});
