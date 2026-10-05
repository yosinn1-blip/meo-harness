// LINE Flex Message ビルダー — クチコミ返信承認フロー
//
// 各レビューを bubble にして carousel でまとめる。
// replyId あり: [送信] + [スキップ]。editable（自己登録版）は [送信] + [編集する] の2つ
// replyId なし: [確認済み] の1ボタン（非 GBP 店舗、ダイジェスト確認用）

// ボタンを押すと利用者の吹き出しとして出る文（postback の displayText）。
// 受信側（approvals.mjs）が返信案と取り違えないよう、同じ定数を共有する。
export const SEND_DISPLAY_TEXT = '「送信」を押しました';
export const EDIT_DISPLAY_TEXT = '「編集する」を押しました';

function stars(n) {
  const f = Math.max(0, Math.min(5, n));
  return '★'.repeat(f) + '☆'.repeat(5 - f);
}

function truncate(s, n) {
  const t = (s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function buildReviewBubble({ replyId, review, bizName, rev = 1, editable = false, variant = 'notify' }) {
  const preview = variant === 'preview';
  const reviewTime = Date.parse(review.updateTime ?? review.createTime);
  const starLine = `${stars(review.star)}  ${review.name ?? '匿名'}`;
  // 承認する前に全文を読めるよう、口コミも返信案も実質切らない（Flex の容量上限への保険だけ残す）
  const reviewText = truncate(review.text, 1000);
  const draftText = truncate(review.draft ?? '', 1500);
  const needsFullDraft = Boolean(review.fullTextUrl && (review.draft ?? '').length > 1500);
  const hasReplyId = Boolean(replyId) && Boolean(draftText) && !needsFullDraft;

  const footerContents = hasReplyId
    ? [
        {
          type: 'button',
          style: 'primary',
          height: 'md',
          action: { type: 'postback', label: '送信', displayText: SEND_DISPLAY_TEXT, data: rev > 1 ? `approve:${replyId}:r${rev}` : `approve:${replyId}` },
        },
        ...(editable ? [{
          type: 'button',
          style: 'secondary',
          height: 'md',
          action: { type: 'postback', label: '編集する', displayText: EDIT_DISPLAY_TEXT, data: `edit:${replyId}` },
        }] : [{
          // 旧方式のカードだけ。自己登録版は「押さない」＝返信しない（7日で失効）
          type: 'button',
          style: 'secondary',
          height: 'md',
          action: { type: 'postback', label: 'スキップ', data: `skip:${replyId}` },
        }]),
      ]
    : [
        {
          type: 'button',
          style: 'secondary',
          height: 'md',
          action: { type: 'postback', label: '確認済み', data: `skip:${replyId ?? 'none'}` },
        },
      ];

  let bodyLink = [];
  if (review.fullTextUrl && /^https:\/\//.test(review.fullTextUrl) && (needsFullDraft || (review.text ?? '').length > 1000)) {
    const fullLink = {type:'button',style:'link',height:'sm',action:{type:'uri',label:'全文を確認',uri:review.fullTextUrl}};
    if (needsFullDraft) {
      footerContents.length = 0;
      footerContents.push(fullLink);
    } else bodyLink = [fullLink];
  }

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: preview ? '#5B6FB5' : '#27ACB2',
      paddingAll: '12px',
      contents: [{
        type: 'text',
        text: `${preview ? '✏️ 編集した返信案の確認' : '🔔 新着クチコミ'}${bizName ? `（${bizName}）` : ''}`,
        weight: 'bold',
        size: 'sm',
        color: preview ? '#ffffff' : '#14303F',
        ...(preview ? { wrap: true } : {}),
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
            reviewText
              ? { type: 'text', text: `「${reviewText}」`, size: 'sm', color: '#555555', wrap: true }
              : { type: 'text', text: '（コメントなし・星だけの口コミです）', size: 'sm', color: '#666666', wrap: true },
            ...(Number.isFinite(reviewTime) ? [{
              type: 'text',
              text: new Date(reviewTime + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '/') + ' の口コミ',
              size: 'xs', color: '#666666',
            }] : []),
          ],
        },
        ...(draftText ? [
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: preview ? '編集した返信案' : '返信案', size: 'xs', color: '#666666' },
              { type: 'text', text: draftText, size: 'sm', wrap: true },
              // 自己登録版: 期限と「押さなければ投稿されない」を本文に明示（2026-10-05 チラシ点検 F07）
              ...(editable && hasReplyId ? [{ type: 'text', text: 'この返信案は7日で消えます。何も押さなければ投稿されません。', size: 'sm', color: '#666666', wrap: true }] : []),
            ],
          },
        ] : []),
        ...bodyLink,
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
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
      contents: [{ type: 'text', text: `ほか ${rest}件`, size: 'md', align: 'center', color: '#666666' }],
    },
  };
}

export function buildFlexPayload({ to, reviews, bizName }) {
  const carousels = [[]];
  let size = 0;
  let placed = 0;
  for (const r of reviews) {
    const bubble = buildReviewBubble({ replyId: r.replyId, review: r, bizName, rev: r.rev, editable: r.editable });
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
