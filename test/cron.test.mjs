import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePendingReviews, shouldSendDigest } from '../src/cron.mjs';

test('mergePendingReviews: 既存バッファに新しいレビューを追加する', () => {
  const existing = [{ star: 5, text: 'よかった' }];
  const incoming = [{ star: 3, text: '普通' }];
  const result = mergePendingReviews(existing, incoming);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], existing[0]);
  assert.deepEqual(result[1], incoming[0]);
});

test('mergePendingReviews: 既存バッファが空でも動く', () => {
  const result = mergePendingReviews([], [{ star: 4, text: 'good' }]);
  assert.equal(result.length, 1);
});

test('mergePendingReviews: null/undefined を空配列として扱う', () => {
  assert.equal(mergePendingReviews(null, [{ star: 1, text: 'x' }]).length, 1);
  assert.equal(mergePendingReviews([{ star: 1, text: 'x' }], null).length, 1);
});

test('shouldSendDigest: notifyMode=daily-digest → true', () => {
  assert.equal(shouldSendDigest({ notifyMode: 'daily-digest' }), true);
});

test('shouldSendDigest: notifyMode=immediate → false', () => {
  assert.equal(shouldSendDigest({ notifyMode: 'immediate' }), false);
});

test('shouldSendDigest: notifyMode 未設定 → false', () => {
  assert.equal(shouldSendDigest({}), false);
  assert.equal(shouldSendDigest(null), false);
});
