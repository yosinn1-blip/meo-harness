// MEO Harness — 通知チャネル抽象化レイヤー
//
// 各チャネルプロバイダを共通インターフェースで差し替え可能にする。
// 既定チャネル: line（後方互換維持）
// グローバル用追加: telegram（審査なし・無料・4096字）
//
// インターフェース:
//   sendDigest({ store, reviews, dryRun?, fetchImpl? })
//     → Promise<{ sent, dryRun?, payload?, skipped? }>
//
// KV store スキーマに notificationChannel を追加することで切替可能（未設定 → 'line'）:
//   line:     { lineChannelToken, lineUserId }
//   telegram: { telegramBotToken, telegramChatId }

import { sendLineDigest, buildDigestText } from './line-notify.mjs';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MAX_TEXT = 4096;

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

/**
 * 新着クチコミのダイジェストを、店舗の notificationChannel に応じて送信する。
 * @param {object} args
 * @param {object} args.store  KV から取得した店舗オブジェクト
 * @param {Array}  args.reviews
 * @param {boolean} [args.dryRun]
 * @param {function} [args.fetchImpl]
 */
export async function sendDigest({ store, reviews, dryRun = false, fetchImpl }) {
  if (!reviews?.length) return { skipped: 'no-reviews', sent: 0 };

  const channel = store.notificationChannel ?? 'line';

  if (channel === 'line') {
    return sendLineDigest({
      channelAccessToken: store.lineChannelToken,
      to: store.lineUserId,
      reviews,
      digest: { bizName: store.businessName },
      dryRun,
      fetchImpl,
    });
  }

  if (channel === 'telegram') {
    return sendViaTelegram({ store, reviews, dryRun, fetchImpl });
  }

  throw new Error(`Unknown notification channel: ${channel}`);
}
