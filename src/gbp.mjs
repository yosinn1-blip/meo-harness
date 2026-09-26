// Google Business Profile API クライアント（v1 サブ API）
//
// 必要な OAuth2 スコープ: https://www.googleapis.com/auth/business.manage
//
// 口コミは今も v4（mybusiness.googleapis.com/v4）のみ。v1 の口コミ API は存在しない
// （mybusinessreviews.googleapis.com は 404。2026-09-27 実機確認・公式 review-data ドキュメントも v4）。
// 店舗情報・アカウントは v1 サブ API:
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
const GBP_REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';
const GBP_ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const GBP_LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

// GBP API で口コミを直接取得できる店舗か。取得できる店舗は Gmail 通知経由の処理を行わない（二重通知防止）。
export function hasGbpApi(store) {
  return Boolean(store?.gbpRefreshToken && store?.gbpAccountId && store?.gbpLocationId);
}

// アカウント横断で店舗がちょうど1つなら、その ID を返す（小規模店はほぼこれ。選ぶ手間を省く）。
export function pickSingleLocation(locationsByAccount) {
  const all = (locationsByAccount ?? []).flatMap(({ account, locations }) =>
    (locations ?? []).map(loc => ({ gbpAccountId: account.name, gbpLocationId: loc.name, title: loc.title })));
  return all.length === 1 ? all[0] : null;
}

export function isValidGbpIds({ gbpAccountId, gbpLocationId } = {}) {
  return /^accounts\/\d+$/.test(gbpAccountId ?? '') && /^locations\/\d+$/.test(gbpLocationId ?? '');
}

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
    updateTime: raw.updateTime,
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
 * 届いている招待（お店が運営者を「管理者」に招待したもの等）の一覧。
 * @returns {Promise<Array<{name:string, role:string, targetType?:string, targetLocation?:{locationName:string,address?:string}}>>}
 */
export async function listGbpInvitations({ accessToken, accountId, fetchImpl }) {
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(`${GBP_ACCOUNTS_BASE}/${accountId}/invitations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP invitations 取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.invitations ?? [];
}

/** 招待を承認する。name は "accounts/…/invitations/…" 形式。 */
export async function acceptGbpInvitation({ accessToken, name, fetchImpl }) {
  if (!/^accounts\/\d+\/invitations\/[\w-]+$/.test(name ?? '')) throw new Error(`招待の name が不正です: ${name}`);
  const _fetch = fetchImpl ?? globalThis.fetch;
  const res = await _fetch(`${GBP_ACCOUNTS_BASE}/${name}:accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GBP invitation 承認失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  return { ok: true, name };
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

// Paged variants preserve the legacy array-returning API.
async function getPage(url,{accessToken,fetchImpl=fetch},key){
 const r=await fetchImpl(url,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Object.assign(new Error('GBP_API_UNAVAILABLE'),{status:r.status});
 const data=await r.json();return {items:data[key]??[],nextPageToken:data.nextPageToken??null};
}
export function listGbpAccountsPage({accessToken,pageToken,fetchImpl}){const u=new URL(`${GBP_ACCOUNTS_BASE}/accounts`);u.searchParams.set('pageSize','20');if(pageToken)u.searchParams.set('pageToken',pageToken);return getPage(u,{accessToken,fetchImpl},'accounts');}
export function listGbpLocationsPage({accessToken,accountId,pageToken,fetchImpl}){const u=new URL(`${GBP_LOCATIONS_BASE}/${accountId}/locations`);u.searchParams.set('readMask','name,title');u.searchParams.set('pageSize','50');if(pageToken)u.searchParams.set('pageToken',pageToken);return getPage(u,{accessToken,fetchImpl},'locations');}
export function fetchGbpReviewsPage({accessToken,accountId,locationId,pageToken,pageSize=50,fetchImpl}){const u=new URL(`${GBP_REVIEWS_BASE}/${accountId}/${locationId}/reviews`);u.searchParams.set('pageSize',String(Math.min(pageSize,50)));u.searchParams.set('orderBy','updateTime desc');if(pageToken)u.searchParams.set('pageToken',pageToken);return getPage(u,{accessToken,fetchImpl},'reviews');}
export async function getGbpReview({accessToken,accountId,locationId,reviewId,fetchImpl=fetch}){
 const r=await fetchImpl(`${GBP_REVIEWS_BASE}/${accountId}/${locationId}/reviews/${encodeURIComponent(reviewId)}`,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Object.assign(new Error('GBP_API_UNAVAILABLE'),{status:r.status});return r.json();
}
