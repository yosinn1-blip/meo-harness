import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGbpAccessToken, fetchGbpReviews, normalizeGbpReview, postGbpReply } from '../src/gbp.mjs';

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
