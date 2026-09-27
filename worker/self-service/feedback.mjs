import { readSelfConfig } from "./config.mjs";
import { authorizeLineActor } from "./line-link.mjs";
import { sha256 } from "./crypto.mjs";
import { consumeRate } from "./abuse.mjs";
import { dateKeys } from "./contracts.mjs";
import { budgetStatement, reserveUsage, settleUsage } from "./budget.mjs";
import { buildReviewBubble } from "../../src/line-flex.mjs";
const messages = {
  POSTED: "Googleへの投稿を確認しました。",
  SKIPPED: "この返信案をスキップしました。Googleには投稿していません。",
  REVIEW_CONFLICT:
    "口コミが更新されたか、すでに別の返信があります。上書きせず停止しました。Google上の内容を確認してください。",
  REAPPROVAL_REQUIRED:
    "まだ投稿されていないことを確認しました。同じ返信案を投稿する場合は、内容を確認してもう一度「送信」を押してください。",
  POST_RESULT_UNKNOWN:
    "Googleへの送信結果はまだ未確認です。自動で再投稿せず、照合します。アカウント画面で結果を確認してください。",
  POST_CHECK_FAILED:
    "処理結果を確認できませんでした。投稿成功とは限りません。アカウント画面を確認してください。",
  POST_PENDING:
    "投稿または照合を処理中です。連打せず、アカウント画面で結果を確認してください。",
  ALREADY_HANDLED:
    "この通知は処理済みです。投稿・スキップなどの結果はアカウント画面で確認してください。",
  REPLY_EXPIRED:
    "返信案の有効期限が切れています。このボタンからは投稿しません。",
  REPLY_STALE: "停止・再接続前の古い通知です。このボタンからは投稿しません。",
  STORE_INACTIVE: "現在は停止中または再接続が必要なため投稿していません。",
  PROCESSING_CLOSED: "処理を一時停止しているため投稿していません。",
  EDIT_WAITING:
    "編集した返信文を、このトークにそのまま送ってください（10分以内・1200字まで）。やめる場合は「やめる」と送ってください。",
  EDIT_CANCELLED:
    "編集をやめました。元の返信案のカードから承認・スキップできます。",
  EDIT_INVALID:
    "返信文が空か、1200字を超えています。もう一度送ってください。やめる場合は「やめる」と送ってください。",
  DRAFT_CHANGED:
    "この返信案は編集されています。最新の確認カードから「送信」を押してください。",
  DRAFT_EDITED: "この内容でGoogleに返信しますか？ よければ「送信」を押してください。",
};
// Conversational steps: the account URL would only add noise.
const noAccountLink = new Set(["EDIT_WAITING", "EDIT_CANCELLED", "EDIT_INVALID", "DRAFT_EDITED"]);
export async function sendSelfFeedback(ctx, event, result) {
  if (readSelfConfig(ctx.env).pilotMode) return;
  const message = messages[result?.code];
  const id =
    /^(approve|skip|edit):(ss_[\w-]+)(?::r\d{1,4})?$/.exec(
      event.postback?.data ?? "",
    )?.[2] ?? (event.type === "message" ? result?.replyId : undefined);
  if (
    !message ||
    !id ||
    typeof event.replyToken !== "string" ||
    event.replyToken.length > 4096 ||
    !event.replyToken ||
    !ctx.env.LINE_CHANNEL_ACCESS_TOKEN
  )
    return;
  // Recheck owner even for failure codes produced before postback authorization.
  const store = await ctx.db
    .prepare(
      "SELECT s.line_user_id,s.title FROM stores s JOIN replies r ON r.store_id=s.id WHERE r.id=?",
    )
    .bind(id)
    .first();
  if (
    !authorizeLineActor({
      source: event.source,
      registeredUserId: store?.line_user_id,
      active: true,
    })
  )
    return;
  if (typeof event.webhookEventId !== "string") return;
  const key = "line-reply:" + (await sha256(event.webhookEventId));
  const existing = await ctx.db
    .prepare("SELECT state FROM usage_reservations WHERE id=?")
    .bind(key)
    .first();
  if (existing) return;
  try {
    await consumeRate(ctx, {
      bucket: "feedback:" + (await sha256(event.source.userId)),
      limit: 10,
      windowMs: 60000,
    });
    const period = dateKeys(ctx.now()).month;
    await budgetStatement(ctx, {
      scope: "channel",
      period,
      kind: "reply",
      cap: Number.MAX_SAFE_INTEGER,
    }).run();
    if (
      !(
        await reserveUsage(ctx, {
          id: key,
          scope: "channel",
          period,
          kind: "reply",
          units: 1,
        })
      ).ok
    )
      return;
    const response = await ctx.fetchImpl(
      "https://api.line.me/v2/bot/message/reply",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + ctx.env.LINE_CHANNEL_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: feedbackMessages(ctx, result, id, message, store),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    await settleUsage(
      ctx,
      key,
      response.ok
        ? "committed"
        : response.status >= 500
          ? "uncertain"
          : "released",
    );
  } catch {
    try {
      await settleUsage(ctx, key, "uncertain");
    } catch {} /* account remains the fallback; never substitute a paid push */
  }
}

function feedbackMessages(ctx, result, id, message, store) {
  const text = noAccountLink.has(result.code)
    ? message
    : message + "\n" + ctx.env.SELF_PUBLIC_ORIGIN + "/account";
  if (result.code !== "DRAFT_EDITED" || !result.preview) return [{ type: "text", text }];
  const { review, draft, rev } = result.preview;
  return [
    { type: "text", text },
    {
      type: "flex",
      altText: "編集した返信案の確認",
      contents: buildReviewBubble({
        replyId: id,
        review: { ...review, name: (review.name ?? "匿名").slice(0, 80), draft },
        bizName: String(store?.title ?? "").slice(0, 80),
        rev,
        editable: true,
      }),
    },
  ];
}
