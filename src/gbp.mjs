// Google Business Profile API クライアント（v1 サブ API）
//
// 必要な OAuth2 スコープ: https://www.googleapis.com/auth/business.manage
//
// 旧 mybusiness.googleapis.com/v4 は非推奨（2023年末に廃止）。
// 現行 sub-API を使用:
//   口コミ: mybusinessreviews.googleapis.com/v1
//   店舗情報: mybusinessbusinessinformation.googleapis.com/v1
//   アカウント: mybusinessaccountmanagement.googleapis.com/v1
//
// 店舗 KV に追加するフィールド:
//   gbpRefreshToken — 店舗オーナーの OAuth refresh_token
//   gbpAccountId    — 例: "accounts/123456789"
//   gbpLocationId   — 例: "locations/987654321"
//
// Worker Secrets（wrangler secret put）:
//   GBP_OAUTH_CLIENT_ID
//   GBP_OAUTH_CLIENT_SECRET

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GBP_REVIEWS_BASE = 'https://mybusinessreviews.googleapis.com/v1';
const GBP_ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const GBP_LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export async function getGbpAccessToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP OAuth 失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.access_token;
}

export async function fetchGbpReviews({ accessToken, accountId, locationId, pageSize = 50, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GBP_REVIEWS_BASE}/${accountId}/${locationId}/reviews?pageSize=${pageSize}`;
  const res = await _fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP reviews 取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.reviews ?? [];
}

export function normalizeGbpReview(raw) {
  return {
    reviewId: raw.reviewId,
    star: GBP_STARS[raw.starRating] ?? 0,
    text: raw.comment ?? '',
    name: raw.reviewer?.displayName,
    createTime: raw.createTime,
    hasReply: Boolean(raw.reviewReply),
    platform: 'gbp',
  };
}

/**
 * GBP アカウント一覧を取得する（OAuth 認証後にどのアカウントが使えるか確認する用）。
 * @returns {Promise<Array<{name:string, accountName:string, type:string}>>}
 */
export async function listGbpAccounts({ accessToken, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(`${GBP_ACCOUNTS_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP accounts 取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.accounts ?? [];
}

/**
 * GBP ロケーション（店舗）一覧を取得する。
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.accountId  "accounts/123456789" 形式
 * @param {function} [args.fetchImpl]
 * @returns {Promise<Array<{name:string, title:string, storeCode?:string}>>}
 */
export async function listGbpLocations({ accessToken, accountId, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GBP_LOCATIONS_BASE}/${accountId}/locations?readMask=name,title,storeCode,regularHours`;
  const res = await _fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP locations 取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.locations ?? [];
}

export async function postGbpReply({ accessToken, accountId, locationId, reviewId, comment, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GBP_REVIEWS_BASE}/${accountId}/${locationId}/reviews/${reviewId}/reply`;
  const res = await _fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP reply 投稿失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  return { ok: true, reviewId };
}
