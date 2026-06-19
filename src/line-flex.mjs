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
  const reviewText = truncate(review.text, 80);
  const draftText = truncate(review.draft ?? '', 120);
  const hasReplyId = Boolean(replyId);

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

const MAX_BUBBLES = 10;

export function buildFlexPayload({ to, reviews, bizName }) {
  const shown = reviews.slice(0, MAX_BUBBLES);
  const rest = reviews.length - shown.length;

  const bubbles = shown.map(r => buildReviewBubble({ replyId: r.replyId, review: r, bizName }));

  if (rest > 0) {
    bubbles.push({
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        justifyContent: 'center',
        contents: [{
          type: 'text',
          text: `ほか ${rest}件`,
          size: 'md',
          align: 'center',
          color: '#aaaaaa',
        }],
      },
    });
  }

  return {
    to,
    messages: [{
      type: 'flex',
      altText: `新着クチコミ ${reviews.length}件${bizName ? `（${bizName}）` : ''}`,
      contents: { type: 'carousel', contents: bubbles },
    }],
  };
}
