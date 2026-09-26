// LINE Flex Message ビルダー — クチコミ返信承認フロー
//
// 各レビューを bubble にして carousel でまとめる。
// replyId あり: [承認して送信] + [スキップ] の2ボタン（GBP 連携済み店舗）
// replyId なし: [確認済み] の1ボタン（非 GBP 店舗、ダイジェスト確認用）

function stars(n) {
  const f = Math.max(0, Math.min(5, n));
  return '★'.repeat(f) + '☆'.repeat(5 - f);
}

function truncate(s, n) {
  const t = (s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function buildReviewBubble({ replyId, review, bizName }) {
  const starLine = `${stars(review.star)}  ${review.name ?? '匿名'}`;
  // 承認する前に全文を読めるよう、口コミも返信案も実質切らない（Flex の容量上限への保険だけ残す）
  const reviewText = truncate(review.text, 1000);
  const draftText = truncate(review.draft ?? '', 1500);
  const needsFullDraft = Boolean(review.fullTextUrl && (review.draft ?? '').length > 1500);
  const hasReplyId = Boolean(replyId) && !needsFullDraft;

  const footerContents = hasReplyId
    ? [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          action: { type: 'postback', label: '承認して送信', data: `approve:${replyId}` },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: { type: 'postback', label: 'スキップ', data: `skip:${replyId}` },
        },
      ]
    : [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: { type: 'postback', label: '確認済み', data: `skip:${replyId ?? 'none'}` },
        },
      ];

  if (review.fullTextUrl && /^https:\/\//.test(review.fullTextUrl) && (needsFullDraft || (review.text ?? '').length > 1000)) {
    if (needsFullDraft) footerContents.length = 0;
    footerContents.push({type:'button',style:'link',height:'sm',action:{type:'uri',label:'全文を確認',uri:review.fullTextUrl}});
  }

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#27ACB2',
      paddingAll: '12px',
      contents: [{
        type: 'text',
        text: `🔔 新着クチコミ${bizName ? `（${bizName}）` : ''}`,
        weight: 'bold',
        size: 'sm',
        color: '#ffffff',
      }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: [
            { type: 'text', text: starLine, size: 'sm', weight: 'bold' },
            { type: 'text', text: `「${reviewText}」`, size: 'sm', color: '#555555', wrap: true },
          ],
        },
        ...(draftText ? [
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '返信案', size: 'xs', color: '#aaaaaa' },
              { type: 'text', text: draftText, size: 'sm', wrap: true },
            ],
          },
        ] : []),
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: footerContents,
    },
  };
}

// LINE の上限: カルーセル1つに 10 バブル・約50KB、1回の push に 5 メッセージ。
// 承認ボタンの無い「ほか N件」で口コミを取りこぼさないよう、上限の内側で複数通に分ける。
const MAX_BUBBLES = 10;
const MAX_MESSAGES = 5;
const MAX_CAROUSEL_BYTES = 40_000;

const byteLength = obj => new TextEncoder().encode(JSON.stringify(obj)).length;

function restBubble(rest) {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      contents: [{ type: 'text', text: `ほか ${rest}件`, size: 'md', align: 'center', color: '#aaaaaa' }],
    },
  };
}

export function buildFlexPayload({ to, reviews, bizName }) {
  const carousels = [[]];
  let size = 0;
  let placed = 0;
  for (const r of reviews) {
    const bubble = buildReviewBubble({ replyId: r.replyId, review: r, bizName });
    const b = byteLength(bubble);
    let current = carousels[carousels.length - 1];
    if (current.length >= MAX_BUBBLES || (current.length && size + b > MAX_CAROUSEL_BYTES)) {
      if (carousels.length >= MAX_MESSAGES) break;
      carousels.push(current = []);
      size = 0;
    }
    current.push(bubble);
    size += b;
    placed++;
  }

  let rest = reviews.length - placed;
  if (rest > 0) {
    const last = carousels[carousels.length - 1];
    if (last.length >= MAX_BUBBLES) { last.pop(); rest++; }
    last.push(restBubble(rest));
  }

  const label = `新着クチコミ ${reviews.length}件${bizName ? `（${bizName}）` : ''}`;
  return {
    to,
    messages: carousels.map((bubbles, i) => ({
      type: 'flex',
      altText: carousels.length > 1 ? `${label} ${i + 1}/${carousels.length}` : label,
      contents: { type: 'carousel', contents: bubbles },
    })),
  };
}
