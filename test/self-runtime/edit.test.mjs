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
  assert.equal((await handleSelfPostback(ctx, postback("edit:ss_r"))).code, "EDIT_WAITING");
  const edited = await handleSelfEditText(ctx, text("  ご来店ありがとうございました。またお待ちしております。  "));
  assert.equal(edited.code, "DRAFT_EDITED");
  assert.equal(edited.replyId, "ss_r");
  assert.equal(edited.preview.rev, 2);
  assert.equal(edited.preview.draft, "ご来店ありがとうございました。またお待ちしております。");
  assert.equal(edited.preview.review.text, "元の口コミ");
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
test("edit session expires after 10 minutes and cannot touch handled replies", async (t) => {
  const { ctx, advance } = await setup(t);
  await handleSelfPostback(ctx, postback("edit:ss_r"));
  advance(10 * 60000 + 1);
  assert.equal(await handleSelfEditText(ctx, text("遅れて送った文")), null);
  await handleSelfPostback(ctx, postback("skip:ss_r"));
  assert.equal((await handleSelfPostback(ctx, postback("edit:ss_r"))).code, "ALREADY_HANDLED");
});
