import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGbpAccessToken, fetchGbpReviews, normalizeGbpReview, postGbpReply, listGbpAccounts, listGbpLocations } from '../src/gbp.mjs';

function mockFetch(status, body) {
  return async () => ({
    ok: status < 400,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => JSON.stringify(body),
  });
}

// ── getGbpAccessToken ────────────────────────────────────────────────────────

test('getGbpAccessToken: 成功 → access_token を返す', async () => {
  const token = await getGbpAccessToken({
    clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt',
    fetchImpl: mockFetch(200, { access_token: 'tok123', expires_in: 3600 }),
  });
  assert.equal(token, 'tok123');
});

test('getGbpAccessToken: 401 → エラー', async () => {
  await assert.rejects(
    () => getGbpAccessToken({
      clientId: 'x', clientSecret: 'x', refreshToken: 'x',
      fetchImpl: mockFetch(401, { error: 'invalid_client' }),
    }),
    /GBP OAuth 失敗 401/,
  );
});

// ── fetchGbpReviews ──────────────────────────────────────────────────────────

test('fetchGbpReviews: 成功 → reviews 配列を返す', async () => {
  const raw = [
    { reviewId: 'r1', starRating: 'FIVE', comment: '最高', reviewer: { displayName: '田中' }, createTime: '2026-06-01T00:00:00Z' },
  ];
  const reviews = await fetchGbpReviews({
    accessToken: 'tok', accountId: 'accounts/1', locationId: 'locations/2',
    fetchImpl: mockFetch(200, { reviews: raw }),
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewId, 'r1');
});

test('fetchGbpReviews: reviews なし → 空配列', async () => {
  const reviews = await fetchGbpReviews({
    accessToken: 'tok', accountId: 'accounts/1', locationId: 'locations/2',
    fetchImpl: mockFetch(200, {}),
  });
  assert.deepEqual(reviews, []);
});

test('fetchGbpReviews: 403 → エラー', async () => {
  await assert.rejects(
    () => fetchGbpReviews({
      accessToken: 'bad', accountId: 'accounts/1', locationId: 'locations/2',
      fetchImpl: mockFetch(403, { error: 'PERMISSION_DENIED' }),
    }),
    /GBP reviews 取得失敗 403/,
  );
});

// ── normalizeGbpReview ───────────────────────────────────────────────────────

test('normalizeGbpReview: FIVE → star=5, hasReply=false', () => {
  const r = normalizeGbpReview({
    reviewId: 'r1', starRating: 'FIVE', comment: '良い',
    reviewer: { displayName: '田中' }, createTime: '2026-06-01T00:00:00Z',
  });
  assert.equal(r.reviewId, 'r1');
  assert.equal(r.star, 5);
  assert.equal(r.text, '良い');
  assert.equal(r.name, '田中');
  assert.equal(r.platform, 'gbp');
  assert.equal(r.hasReply, false);
});

test('normalizeGbpReview: FOUR → star=4', () => {
  const r = normalizeGbpReview({ reviewId: 'r2', starRating: 'FOUR', createTime: '2026-06-01T00:00:00Z' });
  assert.equal(r.star, 4);
});

test('normalizeGbpReview: reviewReply あり → hasReply=true', () => {
  const r = normalizeGbpReview({
    reviewId: 'r3', starRating: 'THREE',
    reviewReply: { comment: 'ありがとう', updateTime: '2026-06-02T00:00:00Z' },
    createTime: '2026-06-01T00:00:00Z',
  });
  assert.equal(r.hasReply, true);
});

test('normalizeGbpReview: コメントなし → text=""', () => {
  const r = normalizeGbpReview({ reviewId: 'r4', starRating: 'TWO', createTime: '2026-06-01T00:00:00Z' });
  assert.equal(r.text, '');
  assert.equal(r.name, undefined);
});

// ── postGbpReply ─────────────────────────────────────────────────────────────

test('postGbpReply: 成功 → { ok: true, reviewId }', async () => {
  const result = await postGbpReply({
    accessToken: 'tok', accountId: 'accounts/1', locationId: 'locations/2',
    reviewId: 'r1', comment: 'ありがとうございます',
    fetchImpl: mockFetch(200, {}),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reviewId, 'r1');
});

test('postGbpReply: 404 → エラー', async () => {
  await assert.rejects(
    () => postGbpReply({
      accessToken: 'tok', accountId: 'accounts/1', locationId: 'locations/2',
      reviewId: 'r99', comment: '返信',
      fetchImpl: mockFetch(404, { error: 'NOT_FOUND' }),
    }),
    /GBP reply 投稿失敗 404/,
  );
});

test('postGbpReply: URL に v1 Reviews サブ API が含まれる', async () => {
  let capturedUrl;
  const spyFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  await postGbpReply({
    accessToken: 'tok', accountId: 'accounts/1', locationId: 'locations/2',
    reviewId: 'r1', comment: 'test', fetchImpl: spyFetch,
  });
  assert.ok(capturedUrl.includes('mybusinessreviews.googleapis.com/v1'), `URL should use v1 sub-API, got: ${capturedUrl}`);
});

// ── listGbpAccounts ───────────────────────────────────────────────────────────

test('listGbpAccounts: 成功 → accounts 配列を返す', async () => {
  const mockAccounts = [
    { name: 'accounts/123', accountName: '山田カフェ', type: 'PERSONAL' },
    { name: 'accounts/456', accountName: 'テスト書店', type: 'PERSONAL' },
  ];
  const result = await listGbpAccounts({
    accessToken: 'tok',
    fetchImpl: mockFetch(200, { accounts: mockAccounts }),
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'accounts/123');
  assert.equal(result[0].accountName, '山田カフェ');
});

test('listGbpAccounts: accounts なし → 空配列', async () => {
  const result = await listGbpAccounts({
    accessToken: 'tok',
    fetchImpl: mockFetch(200, {}),
  });
  assert.deepEqual(result, []);
});

test('listGbpAccounts: 401 → エラー', async () => {
  await assert.rejects(
    () => listGbpAccounts({
      accessToken: 'bad',
      fetchImpl: mockFetch(401, { error: { message: 'Unauthorized' } }),
    }),
    /GBP accounts 取得失敗 401/,
  );
});

// ── listGbpLocations ──────────────────────────────────────────────────────────

test('listGbpLocations: 成功 → locations 配列を返す', async () => {
  const mockLocations = [
    { name: 'accounts/123/locations/456', title: '山田カフェ 難波店', storeCode: 'NAMBA-01' },
  ];
  const result = await listGbpLocations({
    accessToken: 'tok',
    accountId: 'accounts/123',
    fetchImpl: mockFetch(200, { locations: mockLocations }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, '山田カフェ 難波店');
  assert.equal(result[0].storeCode, 'NAMBA-01');
});

test('listGbpLocations: locations なし → 空配列', async () => {
  const result = await listGbpLocations({
    accessToken: 'tok', accountId: 'accounts/1',
    fetchImpl: mockFetch(200, {}),
  });
  assert.deepEqual(result, []);
});

test('listGbpLocations: 403 → エラー', async () => {
  await assert.rejects(
    () => listGbpLocations({
      accessToken: 'tok', accountId: 'accounts/1',
      fetchImpl: mockFetch(403, { error: { message: 'PERMISSION_DENIED' } }),
    }),
    /GBP locations 取得失敗 403/,
  );
});

test('listGbpLocations: URL に accountId と v1 が含まれる', async () => {
  let capturedUrl;
  const spyFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ locations: [] }), text: async () => '{}' };
  };
  await listGbpLocations({ accessToken: 'tok', accountId: 'accounts/99', fetchImpl: spyFetch });
  assert.ok(capturedUrl.includes('mybusinessbusinessinformation.googleapis.com/v1'), `URL should use v1 sub-API, got: ${capturedUrl}`);
  assert.ok(capturedUrl.includes('accounts/99'), `URL should include accountId, got: ${capturedUrl}`);
});
