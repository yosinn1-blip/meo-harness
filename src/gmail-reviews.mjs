// MEO Harness — GBP新着レビュー通知メール監視（暫定版・公式API承認待ちのつなぎ）
//
// 設計方針:
// - 公式 Google Business Profile API（legacy v4.9含む）が承認待ちのため、
//   GBPの「新しいクチコミ」メール通知をGmail API経由で検知する代替ルート。
// - 返信の投稿は元から人間が手動でGoogleに貼り付ける前提（自動投稿はAPI承認後の別実装）。
// - 純 fetch のみ → Node（このスクリプト）でも将来 Cloudflare Workers でも動く。
// - OAuthはテスト中ステータスのため refresh_token は7日で失効する（再取得が必要）。

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * refresh_token から新しい access_token を取得する。
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.clientSecret
 * @param {string} args.refreshToken
 * @param {function} [args.fetchImpl]
 * @returns {Promise<{accessToken:string, expiresIn:number}>}
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("clientId / clientSecret / refreshToken が必要です");
  }
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`トークン更新失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/**
 * Gmail検索クエリでメッセージ一覧（ID・スレッドIDのみ）を取得する。
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.query        Gmail検索クエリ（例: 'from:google.com newer_than:7d'）
 * @param {number} [args.maxResults=10]
 * @param {function} [args.fetchImpl]
 * @returns {Promise<Array<{id:string, threadId:string}>>}
 */
export async function searchMessages({ accessToken, query, maxResults = 10, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GMAIL_API}/messages?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`;
  const res = await _fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gmail検索失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.messages ?? [];
}

function decodeBase64Url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** payload.parts を再帰的に辿って text/plain と text/html の本文を集める */
function extractBodies(payload, out = { text: "", html: "" }) {
  if (!payload) return out;
  const data = payload.body?.data;
  if (data) {
    if (payload.mimeType === "text/plain") out.text += decodeBase64Url(data);
    if (payload.mimeType === "text/html") out.html += decodeBase64Url(data);
  }
  for (const part of payload.parts ?? []) extractBodies(part, out);
  return out;
}

/**
 * メッセージ本文・件名・送信者を取得する。
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.id
 * @param {function} [args.fetchImpl]
 * @returns {Promise<{id:string, subject:string, from:string, date:string, snippet:string, text:string, html:string}>}
 */
export async function getMessage({ accessToken, id, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(`${GMAIL_API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`メッセージ取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const headers = data.payload?.headers ?? [];
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const bodies = extractBodies(data.payload);
  return {
    id: data.id,
    subject: header("Subject"),
    from: header("From"),
    date: header("Date"),
    snippet: data.snippet ?? "",
    text: bodies.text,
    html: bodies.html,
  };
}

// GBPの所有権リクエスト通知で確認されている送信元（レビュー通知も同じGoogle Business Profile
// ブランドの送信元を使っている可能性が高いが、件名・本文の正確な実例は未確認）。
export const KNOWN_GBP_SENDERS = ["businessprofile-noreply@google.com", "google-my-business-noreply@google.com"];

/**
 * GBP「新しいクチコミ」通知メールを解析して review オブジェクトを返す。
 * 実例メールが届いたら正規表現を調整すること（2026-06 時点では未着のため best-effort）。
 * @param {object} msg - getMessage() の戻り値
 * @returns {{businessName:string, star:number|null, text:string|null, name:string|null, rawText:string}|null}
 *   null = GBP クチコミ通知ではないと判断した場合
 */
export function parseGbpReviewEmail(msg) {
  const from = msg.from?.toLowerCase() ?? "";
  if (!KNOWN_GBP_SENDERS.some((s) => from.includes(s))) return null;

  const body = msg.text || (msg.html ?? "").replace(/<[^>]+>/g, " ");
  const subject = msg.subject ?? "";

  // 店舗名: 「○○」/ "○○" / "○○" received a new review
  const bizMatch =
    subject.match(/「(.+?)」/) ||
    subject.match(/"(.+?)"/) ||
    subject.match(/^"(.+?)"/) ||
    subject.match(/^(.+?)(?:\s+(?:に|received|got))/);
  const businessName = bizMatch ? bizMatch[1].trim() : "";

  // 星評価: ★★★★☆ / "5 star rating" / "Rating: 4/5"
  let star = null;
  const starJa = body.match(/[★☆]{1,5}/);
  if (starJa) {
    const count = [...starJa[0]].filter((c) => c === "★").length;
    if (count > 0) star = count;
  }
  if (!star) {
    const starEn = body.match(/(\d)\s*(?:star|\/5)/i);
    if (starEn) star = Math.min(5, Math.max(1, parseInt(starEn[1], 10)));
  }

  // レビュアー名
  const reviewerMatch = body.match(/^(.{1,40}?)\s*(?:が|さん|によって)\s*(?:投稿|クチコミ|レビュー)/m) ||
    body.match(/(?:by|from)\s+(.{1,40}?)[\n,]/i);
  const name = reviewerMatch ? reviewerMatch[1].trim() : null;

  // レビュー本文（20 文字以上の行を最大 3 つ結合）
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const long = lines.filter((l) => l.length >= 20 && l.length <= 800);
  const text = long.length ? long.slice(0, 3).join(" ") : null;

  return { businessName, star, text, name, rawText: body.slice(0, 1000) };
}

/**
 * GBPの「新しいクチコミ」通知メールを検索し、本文まで取得する。
 * 検知ロジックは暫定（実例メールが未着のため）。実例が来たら検索クエリ・パーサーを調整すること。
 * 送信元は既知のGBP通知アドレス2件を軸に、google.com全体＋キーワードも保険でORしている。
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.clientSecret
 * @param {string} args.refreshToken
 * @param {string} [args.query]
 * @param {number} [args.maxResults=10]
 * @param {function} [args.fetchImpl]
 */
export async function fetchReviewNotificationEmails({
  clientId,
  clientSecret,
  refreshToken,
  query = `((${KNOWN_GBP_SENDERS.map((s) => `from:${s}`).join(" OR ")}) OR (from:google.com (クチコミ OR review OR レビュー))) newer_than:30d`,
  maxResults = 10,
  fetchImpl,
}) {
  const { accessToken } = await getAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
  const messages = await searchMessages({ accessToken, query, maxResults, fetchImpl });
  const full = [];
  for (const m of messages) {
    full.push(await getMessage({ accessToken, id: m.id, fetchImpl }));
  }
  return full;
}
