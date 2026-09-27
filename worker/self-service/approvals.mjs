import { ensure, SelfError } from "./errors.mjs";
import { getStore } from "./store-repository.mjs";
import { readSelfConfig } from "./config.mjs";
import { authorizeLineActor } from "./line-link.mjs";
import { googleAccessToken } from "./google.mjs";
import { getGbpReview, postGbpReply } from "../../src/gbp.mjs";
import { seal, unseal, tokenKey, sha256 } from "./crypto.mjs";
import { storeGuard } from "./lifecycle.mjs";
export function classifyCurrentReview({
  current,
  approvedDraft,
  storedReviewVersionTime,
}) {
  if (current.reviewReply?.comment === approvedDraft) return "posted";
  if (
    current.reviewReply?.comment ||
    !storedReviewVersionTime ||
    (current.updateTime ?? current.createTime) !== storedReviewVersionTime
  )
    return "conflict";
  return "unchanged";
}
async function replyData(ctx, id) {
  const r = await ctx.db
    .prepare("SELECT * FROM replies WHERE id=?")
    .bind(id)
    .first();
  ensure(r, "NOT_FOUND", 404);
  const j = await ctx.db
    .prepare("SELECT * FROM review_jobs WHERE id=?")
    .bind(r.job_id)
    .first();
  ensure(j, "NOT_FOUND", 404);
  const s = await getStore(ctx, r.store_id);
  ensure(s, "NOT_FOUND", 404);
  return { r, j, s };
}
const EDIT_WINDOW_MS = 10 * 60000;
const CANCEL_WORDS = new Set(["やめる", "やめます", "キャンセル", "中止"]);
async function draftRev(ctx, id) {
  const row = await ctx.db
    .prepare("SELECT rev FROM reply_revisions WHERE reply_id=?")
    .bind(id)
    .first();
  return row?.rev ?? 1;
}
async function texts(ctx, r, j) {
  ensure(
    r.draft_ciphertext && j.payload_ciphertext && r.expires_at > ctx.now(),
    "REPLY_EXPIRED",
    410,
  );
  const draft = await unseal(
    r.draft_ciphertext,
    tokenKey(ctx),
    "reply:" + r.id,
  );
  ensure(
    (await sha256(draft)) === r.draft_hash && draft.length <= 1200,
    "DRAFT_INVALID",
    409,
  );
  return {
    draft,
    review: JSON.parse(
      await unseal(j.payload_ciphertext, tokenKey(ctx), "job:" + j.id),
    ),
  };
}
async function mark(ctx, r, state, stage = state, leaseId = null) {
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM replies r JOIN review_jobs j ON j.id=r.job_id JOIN stores s ON s.id=r.store_id WHERE r.id=? AND r.state=? AND r.generation=s.generation AND s.state='active' AND (? IS NULL OR j.lease_id=?))",
        )
        .bind(r.id, r.state, leaseId, leaseId),
      ctx.db.prepare("UPDATE replies SET state=? WHERE id=?").bind(state, r.id),
      ctx.db
        .prepare(
          "UPDATE review_jobs SET stage=?,lease_id=NULL,lease_until=NULL,updated_at=?,next_attempt_at=? WHERE id=?",
        )
        .bind(
          stage,
          ctx.now(),
          ctx.now() + (state === "post_unknown" ? 60000 : 0),
          r.job_id,
        ),
      ctx.db.prepare("DELETE FROM mutation_guards"),
    ]);
  } catch (e) {
    if (/CHECK constraint failed/i.test(e.message))
      return { ok: false, code: "POST_PENDING" };
    throw e;
  }
  return {
    ok: state === "posted",
    code:
      state === "posted"
        ? "POSTED"
        : state === "conflict"
          ? "REVIEW_CONFLICT"
          : "REAPPROVAL_REQUIRED",
  };
}
export async function readOwnedReply(ctx, actor, id) {
  const { r, j, s } = await replyData(ctx, id);
  ensure(
    s.ownerSub === actor.sub &&
      r.generation === s.generation &&
      r.expires_at > ctx.now() &&
      r.draft_ciphertext &&
      j.payload_ciphertext,
    "NOT_FOUND",
    404,
  );
  const { draft, review } = await texts(ctx, r, j);
  return { reviewText: review.text, draftText: draft, expiresAt: r.expires_at };
}
export async function reconcileReply(ctx, id) {
  if (!readSelfConfig(ctx.env).processingEnabled)
    return { ok: false, code: "PROCESSING_CLOSED" };
  const { r, j, s } = await replyData(ctx, id);
  ensure(
    s.state === "active" && s.generation === r.generation,
    "STORE_INACTIVE",
    409,
  );
  if (!["posting", "post_unknown"].includes(r.state))
    return { ok: false, code: "NOT_PENDING" };
  if (j.lease_until > ctx.now()) return { ok: false, code: "POST_PENDING" };
  const lease = crypto.randomUUID();
  const claimed = await ctx.db
    .prepare(
      "UPDATE review_jobs SET lease_id=?,lease_until=?,next_attempt_at=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM replies r JOIN stores s ON s.id=r.store_id WHERE r.job_id=review_jobs.id AND r.state=? AND r.generation=s.generation AND s.state='active') RETURNING id",
    )
    .bind(lease, ctx.now() + 60000, ctx.now() + 60000, j.id, ctx.now(), r.state)
    .first();
  if (!claimed) return { ok: false, code: "POST_PENDING" };
  const { draft, review } = await texts(ctx, r, j);
  const current = await getGbpReview({
    accessToken: await googleAccessToken(ctx, s.ownerSub),
    accountId: s.accountId,
    locationId: s.locationId,
    reviewId: j.review_id,
    fetchImpl: ctx.fetchImpl,
  });
  const state = classifyCurrentReview({
    current,
    approvedDraft: draft,
    storedReviewVersionTime: review.updateTime ?? review.createTime,
  });
  return state === "unchanged"
    ? mark(ctx, r, "pending", "reapproval_required", lease)
    : mark(
        ctx,
        r,
        state === "posted" ? "posted" : "conflict",
        state === "posted" ? "posted" : "conflict",
        lease,
      );
}
export async function handleSelfPostback(ctx, event) {
  try {
    ensure(readSelfConfig(ctx.env).processingEnabled, "PROCESSING_CLOSED", 503);
    const match = /^(approve|skip|edit):(ss_[\w-]+)(?::r(\d{1,4}))?$/.exec(
      event.postback?.data ?? "",
    );
    ensure(match, "INVALID_ACTION");
    const [, action, id] = match;
    const cardRev = Number(match[3] ?? 1);
    const { r, j, s } = await replyData(ctx, id);
    ensure(s.state === "active", "STORE_INACTIVE", 409);
    ensure(
      authorizeLineActor({
        source: event.source,
        registeredUserId: s.lineUserId,
        active: true,
      }),
      "LINE_ACTOR_DENIED",
      403,
    );
    ensure(
      r.generation === s.generation && j.generation === s.generation,
      "REPLY_STALE",
      409,
    );
    ensure(r.expires_at > ctx.now(), "REPLY_EXPIRED", 410);
    ensure(
      typeof event.webhookEventId === "string" &&
        event.webhookEventId.length < 200,
      "INVALID_EVENT",
    );
    const receipt = await ctx.db
      .prepare("INSERT INTO line_events VALUES (?,?) ON CONFLICT DO NOTHING")
      .bind(event.webhookEventId, ctx.now())
      .run();
    if (!receipt.meta.changes) return { ok: false, code: "DUPLICATE_EVENT" };
    if (action === "edit") {
      if (r.state !== "pending") return { ok: false, code: "ALREADY_HANDLED" };
      await ctx.db
        .prepare(
          "INSERT INTO line_edits VALUES (?,?,?) ON CONFLICT(line_user_id) DO UPDATE SET reply_id=excluded.reply_id,expires_at=excluded.expires_at",
        )
        .bind(event.source.userId, id, ctx.now() + EDIT_WINDOW_MS)
        .run();
      return { ok: true, code: "EDIT_WAITING" };
    }
    if (["posting", "post_unknown"].includes(r.state))
      return reconcileReply(ctx, id);
    if (r.state !== "pending") return { ok: false, code: "ALREADY_HANDLED" };
    if (action === "skip") {
      const result = await ctx.db
        .prepare(
          "UPDATE replies SET state='skipped',draft_ciphertext=NULL WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM stores WHERE id=? AND state='active' AND generation=?)",
        )
        .bind(id, s.id, s.generation)
        .run();
      if (result.meta.changes)
        await ctx.db
          .prepare("UPDATE review_jobs SET stage='skipped' WHERE id=?")
          .bind(j.id)
          .run();
      return { ok: Boolean(result.meta.changes), code: "SKIPPED" };
    }
    // A card from before a rewrite must not post the rewritten text.
    const rev = await draftRev(ctx, id);
    if (cardRev !== rev) return { ok: false, code: "DRAFT_CHANGED" };
    const { draft, review } = await texts(ctx, r, j);
    const args = {
      accessToken: await googleAccessToken(ctx, s.ownerSub),
      accountId: s.accountId,
      locationId: s.locationId,
      reviewId: j.review_id,
      fetchImpl: (url, init) =>
        ctx.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }),
    };
    const current = await getGbpReview(args);
    const classification = classifyCurrentReview({
      current,
      approvedDraft: draft,
      storedReviewVersionTime: review.updateTime ?? review.createTime,
    });
    if (classification !== "unchanged")
      return mark(ctx, r, classification === "posted" ? "posted" : "conflict");
    const lease = crypto.randomUUID();
    try {
      await ctx.db.batch([
        storeGuard(ctx, s, ["active"]),
        ctx.db
          .prepare(
            "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM replies WHERE id=? AND state='pending') AND COALESCE((SELECT rev FROM reply_revisions WHERE reply_id=?),1)=?",
          )
          .bind(id, id, rev),
        ctx.db
          .prepare("UPDATE replies SET state='posting' WHERE id=?")
          .bind(id),
        ctx.db
          .prepare(
            "UPDATE review_jobs SET stage='posting',lease_id=?,lease_until=? WHERE id=?",
          )
          .bind(lease, ctx.now() + 60000, j.id),
        ctx.db.prepare("DELETE FROM mutation_guards"),
      ]);
    } catch {
      return { ok: false, code: "POST_PENDING" };
    }
    const latest = await getStore(ctx, s.id);
    ensure(
      latest?.state === "active" && latest.generation === s.generation,
      "STORE_INACTIVE",
      409,
    );
    try {
      await postGbpReply({ ...args, comment: draft });
      return await mark(
        ctx,
        { ...r, state: "posting" },
        "posted",
        "posted",
        lease,
      );
    } catch {
      await mark(
        ctx,
        { ...r, state: "posting" },
        "post_unknown",
        "post_unknown",
        lease,
      );
      return { ok: false, code: "POST_RESULT_UNKNOWN" };
    }
  } catch (e) {
    return {
      ok: false,
      code: e instanceof SelfError ? e.code : "POST_CHECK_FAILED",
    };
  }
}

// Free text after "書き直す" becomes the new draft. Returns null when the
// message is ordinary chat (no live edit session for this LINE user).
export async function handleSelfEditText(ctx, event) {
  if (!readSelfConfig(ctx.env).processingEnabled) return null;
  if (
    event?.type !== "message" ||
    event.message?.type !== "text" ||
    event.source?.type !== "user" ||
    !event.source.userId
  )
    return null;
  const userId = event.source.userId;
  const session = await ctx.db
    .prepare("SELECT * FROM line_edits WHERE line_user_id=? AND expires_at>?")
    .bind(userId, ctx.now())
    .first();
  if (!session) return null;
  const id = session.reply_id;
  const endSession = () =>
    ctx.db.prepare("DELETE FROM line_edits WHERE line_user_id=?").bind(userId).run();
  try {
    ensure(
      typeof event.webhookEventId === "string" && event.webhookEventId.length < 200,
      "INVALID_EVENT",
    );
    const { r, j, s } = await replyData(ctx, id);
    if (!authorizeLineActor({ source: event.source, registeredUserId: s.lineUserId, active: true })) {
      await endSession();
      return null;
    }
    const receipt = await ctx.db
      .prepare("INSERT INTO line_events VALUES (?,?) ON CONFLICT DO NOTHING")
      .bind(event.webhookEventId, ctx.now())
      .run();
    if (!receipt.meta.changes) return { ok: false, code: "DUPLICATE_EVENT", replyId: id };
    const body = String(event.message.text ?? "").trim();
    if (CANCEL_WORDS.has(body)) {
      await endSession();
      return { ok: true, code: "EDIT_CANCELLED", replyId: id };
    }
    if (!body || body.length > 1200)
      return { ok: false, code: "EDIT_INVALID", replyId: id };
    if (s.state !== "active" || r.generation !== s.generation) {
      await endSession();
      return { ok: false, code: "STORE_INACTIVE", replyId: id };
    }
    if (r.state !== "pending") {
      await endSession();
      return { ok: false, code: "ALREADY_HANDLED", replyId: id };
    }
    const { review } = await texts(ctx, r, j);
    const rev = await draftRev(ctx, id);
    try {
      await ctx.db.batch([
        storeGuard(ctx, s, ["active"]),
        ctx.db
          .prepare(
            "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM replies WHERE id=? AND state='pending' AND expires_at>?) AND COALESCE((SELECT rev FROM reply_revisions WHERE reply_id=?),1)=?",
          )
          .bind(id, ctx.now(), id, rev),
        ctx.db
          .prepare("UPDATE replies SET draft_ciphertext=?,draft_hash=? WHERE id=?")
          .bind(await seal(body, tokenKey(ctx), "reply:" + id), await sha256(body), id),
        ctx.db
          .prepare(
            "INSERT INTO reply_revisions VALUES (?,?) ON CONFLICT(reply_id) DO UPDATE SET rev=excluded.rev",
          )
          .bind(id, rev + 1),
        ctx.db.prepare("DELETE FROM line_edits WHERE line_user_id=?").bind(userId),
        ctx.db.prepare("DELETE FROM mutation_guards"),
      ]);
    } catch {
      await endSession();
      return { ok: false, code: "ALREADY_HANDLED", replyId: id };
    }
    return {
      ok: true,
      code: "DRAFT_EDITED",
      replyId: id,
      preview: { review, draft: body, rev: rev + 1 },
    };
  } catch (e) {
    return {
      ok: false,
      code: e instanceof SelfError ? e.code : "EDIT_FAILED",
      replyId: id,
    };
  }
}
