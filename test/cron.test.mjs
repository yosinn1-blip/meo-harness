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

// ── isDigestHour ──────────────────────────────────────────────────────────────

import { isDigestHour } from '../src/cron.mjs';

test('isDigestHour: JST(+9) は UTC 0時に true', () => {
  assert.equal(isDigestHour({ utcOffset: 9 }, 0), true);
});

test('isDigestHour: JST(+9) は UTC 1時に false', () => {
  assert.equal(isDigestHour({ utcOffset: 9 }, 1), false);
});

test('isDigestHour: KST(+9) は JST と同じ', () => {
  assert.equal(isDigestHour({ utcOffset: 9 }, 0), true);
});

test('isDigestHour: 英国 BST(+1) は UTC 8時に true', () => {
  assert.equal(isDigestHour({ utcOffset: 1 }, 8), true);
});

test('isDigestHour: 米国 EST(-5) は UTC 14時に true', () => {
  assert.equal(isDigestHour({ utcOffset: -5 }, 14), true);
});

test('isDigestHour: utcOffset 未設定は JST(+9) をデフォルトにする', () => {
  assert.equal(isDigestHour({}, 0), true);
  assert.equal(isDigestHour({}, 1), false);
});

test('isDigestHour: UTC-8(PST) は UTC 17時に true', () => {
  assert.equal(isDigestHour({ utcOffset: -8 }, 17), true);
});

test('isDigestHour: AEST(+10) は UTC 23時に true（翌日0時を超える折り返し）', () => {
  assert.equal(isDigestHour({ utcOffset: 10 }, 23), true);
});
