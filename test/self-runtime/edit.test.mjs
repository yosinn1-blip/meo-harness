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
  handleSelfEditText,
} from "../../worker/self-service/approvals.mjs";
import { SEND_DISPLAY_TEXT, EDIT_DISPLAY_TEXT } from "../../src/line-flex.mjs";
async function setup(t) {
  const { db } = await withD1(t);
  await applySchema(db);
  const posted = [];
  let now = Date.now();
  const ctx = createSelfContext(fixtureEnv(db), {
    now: () => now,
    fetchImpl: async (input, init = {}) => {
      const u = String(input);
      if (u.includes("/token"))
        return Response.json({ access_token: "fixture" });
      if (init.method === "PUT") {
        posted.push(JSON.parse(init.body).comment);
        return Response.json({});
      }
      return Response.json({
        reviewId: "r1",
        updateTime: "2026-09-26T00:00:00Z",
      });
    },
  });
  const s = await seedStore(ctx);
  await seedGoogleCredential(ctx);
  const review = { text: "元の口コミ", star: 5, name: "客", updateTime: "2026-09-26T00:00:00Z" };
  await db
    .prepare(
      "INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES ('j',?,'r1','v1',1,'notified',?,0,?,?)",
    )
    .bind(s.id, await seal(JSON.stringify(review), tokenKey(ctx), "job:j"), now, now)
    .run();
  await db
    .prepare("INSERT INTO replies VALUES ('ss_r','j',?,1,?,?,'pending',?)")
    .bind(
      s.id,
      await seal("AIの返信案", tokenKey(ctx), "reply:ss_r"),
      await sha256("AIの返信案"),
      now + 86400000,
    )
    .run();
  return { ctx, db, posted, advance: (ms) => (now += ms) };
}
const postback = (data, userId = "line-a") => ({
  type: "postback",
  webhookEventId: crypto.randomUUID(),
  source: { type: "user", userId },
  postback: { data },
});
const text = (body, userId = "line-a") => ({
  type: "message",
  webhookEventId: crypto.randomUUID(),
  source: { type: "user", userId },
  message: { type: "text", text: body },
});
test("owner rewrites a draft in LINE; only the new card can post the new text", async (t) => {
  const { ctx, posted } = await setup(t);
  const waiting = await handleSelfPostback(ctx, postback("edit:ss_r"));
  assert.equal(waiting.code, "EDIT_WAITING");
  assert.equal(waiting.replyId, "ss_r");
  assert.equal(waiting.currentDraft, "AIの返信案");
  const edited = await handleSelfEditText(ctx, text("  ご来店ありがとうございました。またお待ちしております。  "));
  assert.equal(edited.code, "DRAFT_EDITED");
  assert.equal(edited.replyId, "ss_r");
  assert.equal(edited.preview.rev, 2);
  assert.equal(edited.preview.draft, "ご来店ありがとうございました。またお待ちしております。");
  assert.equal(edited.preview.review.text, "元の口コミ");
  const again = await handleSelfPostback(ctx, postback("edit:ss_r"));
  assert.equal(again.currentDraft, edited.preview.draft);
  await handleSelfEditText(ctx, text("やめる"));
  // The old card still says approve:ss_r (rev 1) and must not post the new text.
  assert.equal((await handleSelfPostback(ctx, postback("approve:ss_r"))).code, "DRAFT_CHANGED");
  assert.deepEqual(posted, []);
  assert.equal((await handleSelfPostback(ctx, postback("approve:ss_r:r2"))).code, "POSTED");
  assert.deepEqual(posted, ["ご来店ありがとうございました。またお待ちしております。"]);
  // A later message is ordinary chat, not another edit.
  assert.equal(await handleSelfEditText(ctx, text("ありがとう")), null);
});
test("rewrite ignores other LINE users, cancels on request, and rejects empty or long text", async (t) => {
  const { ctx, db, posted } = await setup(t);
  assert.equal(await handleSelfEditText(ctx, text("勝手な文")), null, "no edit session yet");
  assert.equal((await handleSelfPostback(ctx, postback("edit:ss_r", "intruder"))).code, "LINE_ACTOR_DENIED");
  await handleSelfPostback(ctx, postback("edit:ss_r"));
  assert.equal(await handleSelfEditText(ctx, text("乗っ取り", "intruder")), null);
  assert.equal((await handleSelfEditText(ctx, text("   "))).code, "EDIT_INVALID");
  assert.equal((await handleSelfEditText(ctx, text("あ".repeat(1201)))).code, "EDIT_INVALID");
  assert.equal((await handleSelfEditText(ctx, text("やめる"))).code, "EDIT_CANCELLED");
  assert.equal(await handleSelfEditText(ctx, text("後から送った文")), null);
  assert.equal((await handleSelfPostback(ctx, postback("approve:ss_r"))).code, "POSTED");
  assert.deepEqual(posted, ["AIの返信案"]);
  assert.equal((await db.prepare("SELECT count(*) n FROM line_edits").first()).n, 0);
});
test("edit session expires after 30 minutes and cannot touch handled replies", async (t) => {
  const { ctx, db, advance } = await setup(t);
  await handleSelfPostback(ctx, postback("edit:ss_r"));
  advance(30 * 60000 + 1);
  const expired = await handleSelfEditText(ctx, text("遅れて送った文"));
  assert.equal(expired?.code, "EDIT_EXPIRED");
  assert.equal(expired.replyId, "ss_r");
  assert.equal((await db.prepare("SELECT count(*) n FROM line_edits").first()).n, 0);
  assert.equal(await handleSelfEditText(ctx, text("もう一度送った文")), null);
  await handleSelfPostback(ctx, postback("skip:ss_r"));
  assert.equal((await handleSelfPostback(ctx, postback("edit:ss_r"))).code, "ALREADY_HANDLED");
});

test('LINE-01: expired and tampered drafts cannot start an edit session', async t => {
  const {ctx, db, advance} = await setup(t);
  await db.prepare("UPDATE replies SET draft_hash='tampered' WHERE id='ss_r'").run();
  assert.equal((await handleSelfPostback(ctx, postback('edit:ss_r'))).code, 'DRAFT_INVALID');
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 0);
  advance(86400000);
  assert.equal((await handleSelfPostback(ctx, postback('edit:ss_r'))).code, 'REPLY_EXPIRED');
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 0);
});
test('LINE-05: editing still works beyond 10 minutes and expires exactly at 30', async t => {
  const {ctx, advance, posted} = await setup(t);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  advance(10 * 60000 + 1);
  assert.equal((await handleSelfEditText(ctx, text('直した返信')))?.code, 'DRAFT_EDITED');
  assert.deepEqual(posted, []);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  advance(30 * 60000);
  assert.equal((await handleSelfEditText(ctx, text('さらに直した返信')))?.code, 'EDIT_EXPIRED');
});
test('LINE-05: expired session can cancel; other users and duplicate messages cannot consume it', async t => {
  const {ctx, db, advance} = await setup(t);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  advance(30 * 60000 + 1);
  assert.equal(await handleSelfEditText(ctx, text('別人の文', 'other')), null);
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 1);
  const e = text('重複');
  await db.prepare('INSERT INTO line_events VALUES (?,?)').bind(e.webhookEventId,ctx.now()).run();
  assert.equal((await handleSelfEditText(ctx, e)).code, 'DUPLICATE_EVENT');
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 1);
  assert.equal((await handleSelfEditText(ctx, text('やめる'))).code, 'EDIT_CANCELLED');
});
test('LINE-05: grace ends two hours after expiry even before cron purges rows', async t => {
  const {ctx, db, advance} = await setup(t);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  advance(30 * 60000 + 2 * 3600000 + 1);
  assert.equal(await handleSelfEditText(ctx, text('遅すぎる文')), null);
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 1);
});

test('LINE-05: a lapsed session stays silent once the reply was already posted', async t => {
  const {ctx, db, advance, posted} = await setup(t);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  assert.equal((await handleSelfPostback(ctx, postback('approve:ss_r'))).code, 'POSTED');
  advance(30 * 60000 + 1);
  assert.equal(await handleSelfEditText(ctx, text('ありがとうございました')), null);
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 0);
  assert.deepEqual(posted, ['AIの返信案']);
});
test('LINE-08: a button displayText echo is never taken as a new draft', async t => {
  const {ctx, db, posted} = await setup(t);
  await handleSelfPostback(ctx, postback('edit:ss_r'));
  for (const echo of [SEND_DISPLAY_TEXT, EDIT_DISPLAY_TEXT, ' ' + SEND_DISPLAY_TEXT + ' '])
    assert.equal(await handleSelfEditText(ctx, text(echo)), null);
  assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n, 1, 'edit session stays open');
  assert.equal((await db.prepare('SELECT count(*) n FROM reply_revisions').first()).n, 0);
  const edited = await handleSelfEditText(ctx, text(SEND_DISPLAY_TEXT + '。ありがとうございます'));
  assert.equal(edited.code, 'DRAFT_EDITED', 'only an exact echo is ignored');
  assert.deepEqual(posted, []);
});

for (const body of ['やめる。','やめます！','ｷｬﾝｾﾙ','「やめる」','やめて🙏',' キャンセルします ','取り消し。','やめ','やめた','やめとく','やめときます','きゃんせる','キャンセルで','取消','とりけし','取り消します','中止します','中止で','（キャンセル…）','『 やめる 』']) {
  test(`LINE-07: cancel variant ${body} preserves the original draft`, async t => {
    const {ctx,posted,db} = await setup(t);
    await handleSelfPostback(ctx,postback('edit:ss_r'));
    assert.equal((await handleSelfEditText(ctx,text(body))).code,'EDIT_CANCELLED');
    assert.equal((await db.prepare('SELECT count(*) n FROM line_edits').first()).n,0);
    assert.equal((await handleSelfPostback(ctx,postback('approve:ss_r'))).code,'POSTED');
    assert.deepEqual(posted,['AIの返信案']);
  });
}
for (const body of ['ありがとう！','やめるのはもったいないですね','なし','不要','いらない','戻る',' ＡＢＣ ｶﾅ！ ']) {
  test(`LINE-07: legitimate draft ${body} is not normalized or rejected as cancellation`, async t => {
    const {ctx,posted} = await setup(t);
    await handleSelfPostback(ctx,postback('edit:ss_r'));
    const result = await handleSelfEditText(ctx,text(body));
    assert.equal(result.code,'DRAFT_EDITED');
    assert.equal(result.preview.draft,body.trim());
    assert.deepEqual(posted,[]);
  });
}
