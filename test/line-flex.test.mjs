import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewBubble, buildFlexPayload, SEND_DISPLAY_TEXT, EDIT_DISPLAY_TEXT } from '../src/line-flex.mjs';

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

test('buildReviewBubble: 自己登録版（editable）は「送信」「編集する」の2つだけ', () => {
  const bubble = buildReviewBubble({ replyId: 'ss_1', review: sampleReview, bizName: 'テスト店', editable: true, rev: 2 });
  const buttons = bubble.footer.contents;
  assert.deepEqual(buttons.map((b) => b.action.label), ['送信', '編集する']);
  assert.deepEqual(buttons.map((b) => b.action.data), ['approve:ss_1:r2', 'edit:ss_1']);
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

test('self-service never approves a truncated draft and includes private full-review link',()=>{
 const bubble=buildReviewBubble({replyId:'ss_test',review:{star:5,text:'長'.repeat(1100),draft:'😀'.repeat(800),fullTextUrl:'https://meo.test/account/replies/ss_test'}});
 assert.equal(JSON.stringify(bubble).includes('approve:ss_test'),false);
 assert.ok(JSON.stringify(bubble).includes('/account/replies/ss_test'));
});

test('LINE-03: notification text and expiry note have readable colors and size', () => {
  const bubble = buildReviewBubble({ replyId: 'ss_1', review: sampleReview, editable: true });
  assert.equal(bubble.header.contents[0].color, '#14303F');
  const draft = bubble.body.contents[2].contents;
  assert.equal(draft[0].color, '#666666');
  assert.equal(draft[2].color, '#666666');
  assert.equal(draft[2].size, 'sm');
  assert.equal(draft[2].text, 'この返信案は7日で消えます。何も押さなければ投稿されません。');
  const payload = buildFlexPayload({ to: 'U123', reviews: Array.from({length: 53}, () => sampleReview) });
  assert.equal(payload.messages.at(-1).contents.contents.at(-1).body.contents[0].color, '#666666');
});

test('LINE-11: star-only reviews have a useful placeholder, not empty quotes', () => {
  for (const text of ['', '   ']) {
    const b = buildReviewBubble({ review: { ...sampleReview, text } });
    assert.equal(b.body.contents[0].contents[1].text, '（コメントなし・星だけの口コミです）');
  }
});
test('LINE-11: review dates use JST, prefer updates and omit invalid dates', () => {
  for (const [dates, want] of [
    [{createTime: '2026-10-04T16:00:00Z'}, '2026/10/05 の口コミ'],
    [{createTime: '2026-10-04T16:00:00Z', updateTime: '2026-10-06T00:00:00Z'}, '2026/10/06 の口コミ'],
    [{}, undefined], [{createTime: 'invalid'}, undefined],
    [{createTime: '2026-10-04T16:00:00Z', updateTime: 'invalid'}, undefined],
  ]) {
    const fields = buildReviewBubble({review: {...sampleReview, ...dates}}).body.contents[0].contents;
    assert.equal(fields[2]?.text, want);
    assert.equal(fields.length, want ? 3 : 2);
    if (want) assert.equal(fields[2].color, '#666666');
  }
});

test('LINE-12: preview is visually distinct while retaining revision-safe actions', () => {
  const bubble = buildReviewBubble({ replyId: 'ss_1', review: sampleReview, bizName: '長い店名', editable: true, rev: 2, variant: 'preview' });
  assert.equal(bubble.header.contents[0].text, '✏️ 編集した返信案の確認（長い店名）');
  assert.equal(bubble.header.backgroundColor, '#5B6FB5');
  assert.equal(bubble.header.contents[0].color, '#ffffff');
  assert.equal(bubble.header.contents[0].wrap, true);
  assert.equal(bubble.body.contents[2].contents[0].text, '編集した返信案');
  assert.deepEqual(bubble.footer.contents.map(b => b.action.label), ['送信', '編集する']);
  assert.equal(bubble.footer.contents[0].action.data, 'approve:ss_1:r2');
  const notify = buildFlexPayload({to: 'U123', reviews: [sampleReview]}).messages[0].contents.contents[0];
  assert.equal(notify.header.contents[0].text, '🔔 新着クチコミ');
  assert.equal(notify.header.backgroundColor, '#27ACB2');
});

test('LINE-02: tap targets are md and long-review links do not crowd actions', () => {
  const b = buildReviewBubble({replyId: 'ss_1', review: {...sampleReview, text: '長'.repeat(1100), fullTextUrl: 'https://meo.test/account/replies/ss_1'}, editable: true});
  assert.deepEqual(b.footer.contents.map(x => x.action.label), ['送信', '編集する']);
  assert.deepEqual(b.footer.contents.map(x => x.height), ['md', 'md']);
  assert.deepEqual(b.footer.contents.map(x => x.style), ['primary', 'secondary']);
  assert.equal(b.footer.layout, 'horizontal');
  assert.equal(b.footer.spacing, 'md');
  assert.equal(b.body.contents.at(-1).action.label, '全文を確認');
  assert.equal(b.body.contents.at(-1).action.uri, 'https://meo.test/account/replies/ss_1');
  const longDraft = buildReviewBubble({replyId: 'ss_1', review: {...sampleReview, draft: 'あ'.repeat(1501), fullTextUrl: 'https://meo.test/account/replies/ss_1'}, editable: true});
  assert.deepEqual(longDraft.footer.contents.map(x => x.action.label), ['全文を確認']);
  assert.doesNotMatch(JSON.stringify(longDraft), /approve:/);
  assert.equal(buildReviewBubble({replyId: 'old', review: sampleReview}).footer.contents[1].height, 'md');
  assert.equal(buildReviewBubble({review: sampleReview}).footer.contents[0].height, 'md');
});

test('LINE-08: postbacks acknowledge taps without claiming posting succeeded', () => {
  const b = buildReviewBubble({replyId: 'ss_1', review: sampleReview, editable: true});
  assert.deepEqual(b.footer.contents.map(x => x.action.displayText), ['「送信」を押しました', '「編集する」を押しました']);
  assert.deepEqual([SEND_DISPLAY_TEXT, EDIT_DISPLAY_TEXT], ['「送信」を押しました', '「編集する」を押しました']);
  // 名前・順番・色は印刷済みチラシと同じ（送信=primary 左、編集する=secondary 右）
  assert.deepEqual(b.footer.contents.map(x => [x.action.label, x.style, x.action.data]), [['送信', 'primary', 'approve:ss_1'], ['編集する', 'secondary', 'edit:ss_1']]);
  for (const x of b.footer.contents) assert.ok(x.action.displayText.length <= 300);
  assert.equal(buildReviewBubble({replyId:'old',review:sampleReview}).footer.contents[1].action.displayText, undefined);
  assert.equal(buildReviewBubble({review:sampleReview}).footer.contents[0].action.displayText, undefined);
});
