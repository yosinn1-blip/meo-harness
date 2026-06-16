// MEO Harness — LINE通知（本体Bの通知レイヤー）
//
// 設計方針（[[line-notification-constraints]] を反映）:
// - 旧 LINE Notify は終了済み → Messaging API の push を使う。
// - 各店が自分のLINE公式アカウント（未認証=審査なし・無料）＋チャネルトークンを持つ（BYO）。
//   200通/月の無料枠は各店の口座に乗る＝Yoshiki側に課金が集中しない（構造的に安全）。
// - 既定は「日次ダイジェスト」= 新着をまとめて1通。1通/日なら月30通で200枠に余裕。
//   1口コミ1pushは多店舗・多スタッフで即枯渇するので避ける。
// - 純 fetch のみ → Node（テスト）でも Cloudflare Workers（本番）でも動く。
// - dryRun=true でネットワークを叩かずペイロードだけ返す（LINEアカウント無しで検証可能）。

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_PROFILE_URL = "https://api.line.me/v2/bot/profile";
const MAX_TEXT = 5000; // LINEテキスト1通の文字数上限
const MAX_MESSAGES = 5; // 1リクエストのメッセージ数上限

export function stars(n) {
  const f = Math.max(0, Math.min(5, Math.trunc(n) || 0));
  return "★".repeat(f) + "☆".repeat(5 - f);
}

export function truncate(s, n) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * 新着クチコミの配列から、LINEに送る日次ダイジェスト本文（1通分の文字列）を組む。
 * @param {Array<{star:number,text:string,name?:string,draft?:string}>} reviews
 * @param {object} [opts]
 * @param {string} [opts.bizName]      店名（ヘッダに表示）
 * @param {string} [opts.dashboardUrl] 承認・編集ダッシュボードへのリンク
 * @param {number} [opts.max=5]        本文に詳細表示する最大件数（超過は「ほかN件」）
 * @param {number} [opts.reviewChars=60] 口コミ本文の切り詰め文字数
 * @param {number} [opts.draftChars=90]  返信案の切り詰め文字数
 * @returns {string} 5000字以内のダイジェスト本文
 */
export function buildDigestText(reviews, opts = {}) {
  const { bizName = "", dashboardUrl, max = 5, reviewChars = 60, draftChars = 90 } = opts;
  const total = reviews.length;
  const shown = reviews.slice(0, max);

  const sections = [`🔔 新着クチコミ ${total}件${bizName ? `（${bizName}）` : ""}`];

  shown.forEach((r, i) => {
    const warn = r.star <= 2 ? " ⚠️" : "";
    const name = r.name ? ` ${r.name}` : "";
    const lines = [`${i + 1}. ${stars(r.star)}${warn}${name}`, `「${truncate(r.text, reviewChars)}」`];
    if (r.draft) lines.push(`返信案: ${truncate(r.draft, draftChars)}`);
    sections.push(lines.join("\n"));
  });

  if (total > shown.length) sections.push(`ほか ${total - shown.length}件`);
  if (dashboardUrl) sections.push(`▶ 承認・編集はこちら:\n${dashboardUrl}`);

  let text = sections.join("\n\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + "…";
  return text;
}

export function buildPushPayload({ to, reviews, digest = {} }) {
  return { to, messages: [{ type: "text", text: buildDigestText(reviews, digest) }] };
}

function lineErrorMessage(status, body) {
  if (status === 401) return `LINE 401: チャネルアクセストークンが無効です`;
  if (status === 403) return `LINE 403: 権限不足（Messaging API設定/プランを確認）`;
  if (status === 429) return `LINE 429: 月間無料枠(200通)超過 or レート制限。ダイジェスト化/プラン確認を`;
  return `LINE ${status}: ${String(body).slice(0, 200)}`;
}

/**
 * 新着クチコミのダイジェストを LINE に push する。
 * @param {object} args
 * @param {string} [args.channelAccessToken] BYOトークン（dryRun時は不要）
 * @param {string} args.to        送信先 userId（店主の個人LINE）
 * @param {Array}  args.reviews   buildDigestText と同じ形
 * @param {object} [args.digest]  buildDigestText のオプション
 * @param {boolean}[args.dryRun]  true なら送らずペイロードだけ返す
 * @param {function}[args.fetchImpl]
 * @returns {Promise<{sent:number, payload?:object, dryRun?:boolean, skipped?:string}>}
 */
export async function sendLineDigest({ channelAccessToken, to, reviews, digest = {}, dryRun = false, fetchImpl }) {
  if (!to) throw new Error("送信先 userId (to) が必要です");
  if (!reviews?.length) return { skipped: "no-reviews", sent: 0 };

  const payload = buildPushPayload({ to, reviews, digest });

  if (dryRun) return { dryRun: true, payload, sent: 0 };

  if (!channelAccessToken) throw new Error("channelAccessToken が必要です（dryRun=false時）");
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${channelAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(lineErrorMessage(res.status, body));
    err.status = res.status;
    throw err;
  }
  return { sent: 1, payload };
}

/**
 * チャネルアクセストークン＋userIdが実際に有効か確認する（設置ウィザードの入力検証用）。
 * タイポしたトークンをそのままKVに保存してしまう事故を防ぐ。
 * @param {object} args
 * @param {string} args.channelAccessToken
 * @param {string} args.userId
 * @param {function} [args.fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function verifyLineCredentials({ channelAccessToken, userId, fetchImpl }) {
  if (!channelAccessToken || !userId) return false;
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(`${LINE_PROFILE_URL}/${userId}`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  return res.ok;
}

export const _internals = { LINE_PUSH_URL, LINE_PROFILE_URL, MAX_TEXT, MAX_MESSAGES };
