// Google Business Profile API クライアント
//
// 必要な OAuth2 スコープ: https://www.googleapis.com/auth/business.manage
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
const GBP_BASE = 'https://mybusiness.googleapis.com/v4';
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
  const url = `${GBP_BASE}/${accountId}/${locationId}/reviews?pageSize=${pageSize}`;
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

export async function postGbpReply({ accessToken, accountId, locationId, reviewId, comment, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GBP_BASE}/${accountId}/${locationId}/reviews/${reviewId}/reply`;
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
