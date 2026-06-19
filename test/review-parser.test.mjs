import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/review-parser.mjs';

// ── GBP ──────────────────────────────────────────────────────────────────────

test('normalize gbp: FIVE → star=5', () => {
  const raw = { starRating: 'FIVE', comment: '最高でした', reviewer: { displayName: 'A様' } };
  const r = normalize('gbp', raw);
  assert.equal(r.star, 5);
  assert.equal(r.text, '最高でした');
  assert.equal(r.name, 'A様');
  assert.equal(r.platform, 'gbp');
});

test('normalize gbp: ONE → star=1', () => {
  const r = normalize('gbp', { starRating: 'ONE', comment: 'bad' });
  assert.equal(r.star, 1);
});

test('normalize gbp: コメントなしは空文字', () => {
  const r = normalize('gbp', { starRating: 'THREE' });
  assert.equal(r.text, '');
  assert.equal(r.name, undefined);
});

test('normalize gbp: 不明な starRating はエラー', () => {
  assert.throws(() => normalize('gbp', { starRating: 'SIX' }), /unknown starRating/);
});

// ── Yelp ─────────────────────────────────────────────────────────────────────

test('normalize yelp: event.data ラップあり', () => {
  const raw = { event_type: 'new_review', data: { rating: 4, text: 'Good!', user: { name: 'Bob' } } };
  const r = normalize('yelp', raw);
  assert.equal(r.star, 4);
  assert.equal(r.text, 'Good!');
  assert.equal(r.name, 'Bob');
  assert.equal(r.platform, 'yelp');
});

test('normalize yelp: ラップなし（rating 直置き）', () => {
  const r = normalize('yelp', { rating: 2, text: 'meh' });
  assert.equal(r.star, 2);
});

test('normalize yelp: rating が 0 はエラー', () => {
  assert.throws(() => normalize('yelp', { rating: 0 }), /invalid rating/);
});

test('normalize yelp: rating が 6 はエラー', () => {
  assert.throws(() => normalize('yelp', { rating: 6 }), /invalid rating/);
});

// ── Trustpilot ───────────────────────────────────────────────────────────────

test('normalize trustpilot: event.review ラップあり', () => {
  const raw = {
    event_type: 'review.created',
    review: { stars: 5, title: 'Great', text: 'Excellent service', consumer: { displayName: 'Jane' } },
  };
  const r = normalize('trustpilot', raw);
  assert.equal(r.star, 5);
  assert.equal(r.text, 'Great\nExcellent service');
  assert.equal(r.name, 'Jane');
  assert.equal(r.platform, 'trustpilot');
});

test('normalize trustpilot: title のみ・text なし', () => {
  const r = normalize('trustpilot', { stars: 3, title: 'OK' });
  assert.equal(r.text, 'OK');
});

test('normalize trustpilot: text のみ・title なし', () => {
  const r = normalize('trustpilot', { stars: 1, text: 'Terrible' });
  assert.equal(r.text, 'Terrible');
});

test('normalize trustpilot: stars が文字列でも整数変換される', () => {
  const r = normalize('trustpilot', { stars: '4', text: 'good' });
  assert.equal(r.star, 4);
});

test('normalize trustpilot: stars=0 はエラー', () => {
  assert.throws(() => normalize('trustpilot', { stars: 0 }), /invalid stars/);
});

// ── 未知プラットフォーム ───────────────────────────────────────────────────────

test('normalize: 未知プラットフォームはエラー', () => {
  assert.throws(() => normalize('google_maps', {}), /Unsupported platform/);
});
