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

test('buildReviewBubble: 長い text は切り詰められる', () => {
  const longReview = { star: 5, text: 'a'.repeat(200), name: '佐藤', draft: '返信' };
  const bubble = buildReviewBubble({ replyId: 'x', review: longReview });
  const textEl = bubble.body.contents[0].contents[1];
  assert.ok(textEl.text.length <= 85); // 80 + "…" + 「」
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

test('buildFlexPayload: 10件超は 10 + ほかN件 bubble', () => {
  const reviews = Array.from({ length: 13 }, (_, i) => ({ ...sampleReview, replyId: `r${i}` }));
  const payload = buildFlexPayload({ to: 'U123', reviews });
  const bubbles = payload.messages[0].contents.contents;
  assert.equal(bubbles.length, 11); // 10 + "ほか3件"
  const lastBubble = bubbles[10];
  assert.match(lastBubble.body.contents[0].text, /ほか 3件/);
});
