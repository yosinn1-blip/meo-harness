// MEO Harness — 通知チャネル抽象化レイヤー
//
// sendDigest({ store, reviews }) を呼ぶだけで、
// store.notificationChannel に応じて LINE / Telegram に配信する。
//
// LINE: reviews に replyId が含まれる場合は Flex Message（承認ボタン付き）を送る。
//       含まれない場合はプレーンテキストのダイジェストを送る。
// Telegram: 常にプレーンテキスト。

import { sendLineDigest, buildDigestText } from './line-notify.mjs';
import { buildFlexPayload } from './line-flex.mjs';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MAX_TEXT = 4096;

// ── LINE ─────────────────────────────────────────────────────────────────────

async function sendViaLine({ store, reviews, dryRun = false, fetchImpl }) {
  const hasInteractive = reviews.some(r => r.replyId);

  if (hasInteractive) {
    const payload = buildFlexPayload({
      to: store.lineUserId,
      reviews,
      bizName: store.businessName,
    });

    if (dryRun) return { dryRun: true, payload, sent: 0 };

    const _fetch = fetchImpl ?? globalThis.fetch;
    const res = await _fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${store.lineChannelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LINE Flex ${res.status}: ${body.slice(0, 200)}`);
    }
    return { sent: 1, payload };
  }

  return sendLineDigest({
    channelAccessToken: store.lineChannelToken,
    to: store.lineUserId,
    reviews,
    digest: { bizName: store.businessName },
    dryRun,
    fetchImpl,
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────

function buildTelegramPayload({ store, reviews }) {
  const { telegramChatId, businessName } = store;
  let text = buildDigestText(reviews, { bizName: businessName });
  if (text.length > TELEGRAM_MAX_TEXT) text = text.slice(0, TELEGRAM_MAX_TEXT - 1) + '…';
  return { chat_id: telegramChatId, text };
}

async function sendViaTelegram({ store, reviews, dryRun = false, fetchImpl }) {
  const { telegramBotToken } = store;
  const payload = buildTelegramPayload({ store, reviews });

  if (dryRun) return { dryRun: true, payload, sent: 0 };

  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${TELEGRAM_API_BASE}/bot${telegramBotToken}/sendMessage`;
  const res = await _fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.description ?? JSON.stringify(data).slice(0, 200)}`);
  }
  return { sent: 1, payload };
}

// ── 公開インターフェース ────────────────────────────────────────────────────────

export async function sendDigest({ store, reviews, dryRun = false, fetchImpl }) {
  if (!reviews?.length) return { skipped: 'no-reviews', sent: 0 };

  const channel = store.notificationChannel ?? 'line';

  if (channel === 'line') return sendViaLine({ store, reviews, dryRun, fetchImpl });
  if (channel === 'telegram') return sendViaTelegram({ store, reviews, dryRun, fetchImpl });

  throw new Error(`Unknown notification channel: ${channel}`);
}
