import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewBubble, buildFlexPayload } from '../src/line-flex.mjs';

const sampleReview = { star: 4, text: '良いサービスでした', name: '田中太郎', draft: 'ありがとうございます！' };

// ── buildReviewBubble ────────────────────────────────────────────────────────

test('buildReviewBubble: replyId あり → 承認/スキップ 2ボタン', () => {
  const bubble = buildReviewBubble({ replyId: 'uuid-1', review: sampleReview, bizName: 'テスト店' });
  assert.equal(bubble.type, 'bubble');
  const buttons = bubble.footer.contents;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].action.data, 'approve:uuid-1');
  assert.equal(buttons[1].action.data, 'skip:uuid-1');
});

test('buildReviewBubble: replyId なし → 確認済みボタン 1つ', () => {
  const bubble = buildReviewBubble({ replyId: null, review: sampleReview });
  const buttons = bubble.footer.contents;
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].action.data, /^skip:/);
});

test('buildReviewBubble: ヘッダーに bizName が含まれる', () => {
  const bubble = buildReviewBubble({ replyId: 'x', review: sampleReview, bizName: '山田商店' });
  const headerText = bubble.header.contents[0].text;
  assert.match(headerText, /山田商店/);
});

test('buildReviewBubble: draft がない場合 body に separator なし', () => {
  const noDraft = { ...sampleReview, draft: undefined };
  const bubble = buildReviewBubble({ replyId: 'x', review: noDraft });
  const bodyContents = bubble.body.contents;
  const hasSeparator = bodyContents.some(c => c.type === 'separator');
  assert.equal(hasSeparator, false);
});

test('buildReviewBubble: 承認前に全文を読めるよう、普通の長さの口コミと返信案は切らない', () => {
  const review = { star: 5, text: 'a'.repeat(400), name: '佐藤', draft: 'b'.repeat(600) };
  const json = JSON.stringify(buildReviewBubble({ replyId: 'x', review }));
  assert.ok(json.includes('a'.repeat(400)));
  assert.ok(json.includes('b'.repeat(600)));
});

test('buildReviewBubble: 極端に長い text は切り詰められる', () => {
  const longReview = { star: 5, text: 'a'.repeat(3000), name: '佐藤', draft: '返信' };
  const bubble = buildReviewBubble({ replyId: 'x', review: longReview });
  const textEl = bubble.body.contents[0].contents[1];
  assert.ok(textEl.text.length <= 1005);
});

// ── buildFlexPayload ──────────────────────────────────────────────────────────

test('buildFlexPayload: to と altText が正しい', () => {
  const payload = buildFlexPayload({ to: 'U123', reviews: [sampleReview], bizName: 'テスト店' });
  assert.equal(payload.to, 'U123');
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].type, 'flex');
  assert.match(payload.messages[0].altText, /テスト店/);
});

test('buildFlexPayload: carousel に bubbles が含まれる', () => {
  const reviews = Array.from({ length: 3 }, (_, i) => ({ ...sampleReview, replyId: `r${i}` }));
  const payload = buildFlexPayload({ to: 'U123', reviews });
  const carousel = payload.messages[0].contents;
  assert.equal(carousel.type, 'carousel');
  assert.equal(carousel.contents.length, 3);
});

test('buildFlexPayload: 10件超は複数通に分け、全件に承認ボタンを付ける', () => {
  const reviews = Array.from({ length: 13 }, (_, i) => ({ ...sampleReview, replyId: `r${i}` }));
  const payload = buildFlexPayload({ to: 'U123', reviews });
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].contents.contents.length, 10);
  assert.equal(payload.messages[1].contents.contents.length, 3);
  assert.match(payload.messages[1].altText, /2\/2/);
  const json = JSON.stringify(payload);
  for (let i = 0; i < 13; i++) assert.ok(json.includes(`approve:r${i}`));
});

test('buildFlexPayload: 長い口コミでもカルーセル1つが容量上限を超えない', () => {
  const reviews = Array.from({ length: 10 }, (_, i) => ({ star: 3, name: 'x', text: 'あ'.repeat(900), draft: 'い'.repeat(1400), replyId: `r${i}` }));
  const payload = buildFlexPayload({ to: 'U123', reviews });
  assert.ok(payload.messages.length > 1);
  for (const m of payload.messages) assert.ok(new TextEncoder().encode(JSON.stringify(m.contents)).length <= 50_000);
  const json = JSON.stringify(payload);
  for (let i = 0; i < 10; i++) assert.ok(json.includes(`approve:r${i}`));
});

test('buildFlexPayload: 5通でも収まらない分は「ほか N件」にまとめる', () => {
  const reviews = Array.from({ length: 53 }, (_, i) => ({ ...sampleReview, replyId: `r${i}` }));
  const payload = buildFlexPayload({ to: 'U123', reviews });
  assert.equal(payload.messages.length, 5);
  const last = payload.messages[4].contents.contents;
  assert.equal(last.length, 10);
  assert.match(last[9].body.contents[0].text, /ほか 4件/);
});
