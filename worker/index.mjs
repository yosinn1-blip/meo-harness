// MEO Harness — 中央窓口 Cloudflare Worker
//
// エンドポイント:
//   GET  /health                         — ヘルスチェック
//   POST /review                         — 口コミ→AI下書き→通知（X-API-Key: store.apiKey）
//   POST /webhook/:platform              — 外部プラットフォーム Webhook（Yelp/Trustpilot/Yahoo!プレイス）
//   POST /signup                         — 設置ウィザード用・公開エンドポイント
//   GET  /admin/stores/:storeId/status   — 店舗ステータス確認（X-Admin-Key: ADMIN_KEY）
//   PUT  /admin/stores/:storeId          — 店舗設定を KV に登録（X-Admin-Key: ADMIN_KEY）
//   DELETE /admin/stores/:storeId        — 店舗設定を KV から削除（X-Admin-Key: ADMIN_KEY）
//   POST /admin/stores/:storeId/notify/test — テスト通知を送信（X-Admin-Key: ADMIN_KEY）
//
// KV スキーマ:
//   key: "store:{storeId}"
//   val: {
//     apiKey, businessName, businessType,
//     notificationChannel: 'line' | 'telegram'  (省略時 → 'line')
//     notifyMode: 'immediate' | 'daily-digest'  (省略時 → 'immediate')
//     utcOffset: number  (UTC オフセット整数: +9=JST/KST, +1=BST, -5=EST。省略時 +9)
//     webhookSecret: string  (Webhook HMAC 署名検証用シークレット)
//     -- LINE --
//     lineChannelToken, lineUserId,
//     -- Telegram --
//     telegramBotToken, telegramChatId,
//   }
//   key: "pending:{storeId}"  — daily-digest モードの未送信レビューバッファ（7日 TTL）
//   val: Array<{ star, text, name?, draft?, ... }>
//
// Secrets（.dev.vars / Workers Secrets）:
//   GROQ_API_KEY — Groq API キー（無料枠）
//   ADMIN_KEY    — 管理エンドポイント認証

import { generateReply, PROVIDERS } from '../src/reply-engine.mjs';
import { verifyLineCredentials } from '../src/line-notify.mjs';
import { sendDigest } from '../src/notify.mjs';
import { mergePendingReviews, shouldSendDigest, isDigestHour } from '../src/cron.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const path = url.pathname;

    try {
      if (method === 'GET' && path === '/health') {
        return json({ status: 'ok', version: env.VERSION ?? '0.1.0' });
      }

      if (method === 'POST' && path === '/review') {
        return await handleReview(request, env);
      }

      if (path.startsWith('/webhook/')) {
        const platform = path.slice('/webhook/'.length);
        if (method === 'POST') return await handleWebhook(request, env, platform);
      }

      if (path === '/signup') {
        if (method === 'OPTIONS') return corsPreflight();
        if (method === 'POST') return await handleSignup(request, env);
      }

      if (path.startsWith('/admin/stores/')) {
        const rest = path.slice('/admin/stores/'.length);
        if (!rest) return jsonError('storeId is required in path', 400);

        if (rest.endsWith('/notify/test')) {
          const storeId = rest.slice(0, -'/notify/test'.length);
          if (method === 'POST') return await handleNotifyTest(request, env, storeId);
        }

        if (rest.endsWith('/status')) {
          const storeId = rest.slice(0, -'/status'.length);
          if (method === 'GET') return await handleAdminStatus(request, env, storeId);
        }

        const storeId = rest;
        if (method === 'PUT') return await handleAdminPut(request, env, storeId);
        if (method === 'DELETE') return await handleAdminDelete(request, env, storeId);
      }

      return jsonError('Not Found', 404);
    } catch (err) {
      return jsonError(`Internal Error: ${err.message}`, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const utcHour = new Date().getUTCHours();
    const list = await env.STORES.list({ prefix: 'pending:' });
    if (!list.keys.length) return;

    const results = await Promise.allSettled(
      list.keys.map(({ name: key }) => handlePendingStore(key, env, utcHour))
    );

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[cron] failed for ${list.keys[i].name}:`, r.reason?.message);
      }
    });
  },
};

// ── 共通パイプライン ──────────────────────────────────────────────────────────
// AI下書き生成 → daily-digest ならバッファ蓄積、immediate なら即時通知

async function processReviews(reviews, store, storeId, env) {
  const { businessName, businessType } = store;

  const settled = await Promise.allSettled(
    reviews.map(review =>
      generateReply({
        review,
        business: { type: businessType ?? '店舗', name: businessName ?? storeId },
        provider: PROVIDERS.GROQ,
        providerConfig: { apiKey: env.GROQ_API_KEY },
      }).then(r => ({ ...review, draft: r.text, warnings: r.warnings, tokens: r.tokens }))
    )
  );

  const processed = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { ...reviews[i], draft: null, draftError: r.reason?.message }
  );
  const failed = processed.filter(r => r.draft == null).length;

  if (shouldSendDigest(store)) {
    const existingRaw = await env.STORES.get(`pending:${storeId}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const merged = mergePendingReviews(existing, processed);
    // GDPR/CCPA: 7日後に自動削除（通知失敗が続いても個人データを無期限保持しない）
    await env.STORES.put(`pending:${storeId}`, JSON.stringify(merged), { expirationTtl: 7 * 24 * 3600 });
    return { buffered: true, count: merged.length };
  }

  const notifyResult = await sendDigest({ store, reviews: processed });
  return { buffered: false, processed: processed.length, failed, notify: notifyResult };
}

// ── Cron: pending バッファの処理 ──────────────────────────────────────────────

async function handlePendingStore(pendingKey, env, utcHour) {
  const storeId = pendingKey.slice('pending:'.length);

  const [storeRaw, pendingRaw] = await Promise.all([
    env.STORES.get(`store:${storeId}`),
    env.STORES.get(pendingKey),
  ]);

  if (!storeRaw) {
    await env.STORES.delete(pendingKey);
    return;
  }

  const store = JSON.parse(storeRaw);

  // タイムゾーンチェック: 店舗の現地 9:00 でなければスキップ（次の該当時刻まで待つ）
  if (!isDigestHour(store, utcHour)) return;

  const reviews = pendingRaw ? JSON.parse(pendingRaw) : [];
  if (!reviews.length) {
    await env.STORES.delete(pendingKey);
    return;
  }

  const settled = await Promise.allSettled(
    reviews.map(review =>
      generateReply({
        review,
        business: { type: store.businessType ?? '店舗', name: store.businessName ?? storeId },
        provider: PROVIDERS.GROQ,
        providerConfig: { apiKey: env.GROQ_API_KEY },
      }).then(r => ({ ...review, draft: r.text, warnings: r.warnings }))
    )
  );

  const processed = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...reviews[i], draft: null }
  );

  // 通知成功時のみバッファ削除。失敗時は次回 Cron で再試行。
  await sendDigest({ store, reviews: processed });
  await env.STORES.delete(pendingKey);
}

// ── /review ──────────────────────────────────────────────────────────────────

async function handleReview(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

  const { storeId, reviews, reviewSource } = body ?? {};
  if (!storeId) return jsonError('storeId is required', 400);
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return jsonError('reviews must be a non-empty array', 400);
  }

  const raw = await env.STORES.get(`store:${storeId}`);
  if (!raw) return jsonError(`Unknown store: ${storeId}`, 404);
  const store = JSON.parse(raw);

  const clientKey = request.headers.get('X-API-Key') ?? '';
  if (clientKey !== store.apiKey) return jsonError('Unauthorized', 401);

  let result;
  try {
    result = await processReviews(reviews, store, storeId, env);
  } catch (err) {
    return json({ ok: false, error: err.message, source: reviewSource ?? 'unknown' }, 500);
  }

  if (result.buffered) {
    return json({ ok: true, buffered: result.count, source: reviewSource ?? 'unknown' });
  }
  return json({ ok: true, ...result, source: reviewSource ?? 'unknown' });
}

// ── /webhook/:platform ────────────────────────────────────────────────────────

async function handleWebhook(request, env, platform) {
  const storeId = request.headers.get('X-Store-Id') ?? '';
  if (!storeId) return jsonError('X-Store-Id header is required', 400);

  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);
  const store = JSON.parse(storeRaw);

  if (!store.webhookSecret) return jsonError('Webhook not configured for this store', 403);

  const rawBody = await request.text();
  const signature = request.headers.get('X-Webhook-Secret') ?? '';

  const { verifyHmac } = await import('../src/hmac.mjs');
  const valid = await verifyHmac(store.webhookSecret, rawBody, signature);
  if (!valid) return jsonError('Invalid webhook signature', 401);

  let rawReview;
  try { rawReview = JSON.parse(rawBody); } catch { return jsonError('Invalid JSON body', 400); }

  const { normalize } = await import('../src/review-parser.mjs');
  let review;
  try {
    review = normalize(platform, rawReview);
  } catch (err) {
    return jsonError(err.message, 400);
  }

  let result;
  try {
    result = await processReviews([review], store, storeId, env);
  } catch (err) {
    return json({ ok: false, error: err.message, platform }, 500);
  }

  if (result.buffered) {
    return json({ ok: true, buffered: result.count, platform });
  }
  return json({ ok: true, ...result, platform });
}

// ── /signup（設置ウィザード） ────────────────────────────────────────────────

async function handleSignup(request, env) {
  let body;
  try { body = await request.json(); } catch { return withCors(jsonError('Invalid JSON body', 400)); }

  const { lineChannelToken, lineUserId, businessName, businessType, timezone } = body ?? {};
  if (!lineChannelToken || !lineUserId) {
    return withCors(jsonError('lineChannelToken, lineUserId are required', 400));
  }

  const verified = await verifyLineCredentials({ channelAccessToken: lineChannelToken, userId: lineUserId });
  if (!verified) {
    return withCors(jsonError(
      'LINEの認証情報を確認できませんでした。チャネルアクセストークンとuserIdに入力ミスがないか確認してください',
      400,
    ));
  }

  const storeId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const store = {
    lineChannelToken, lineUserId, businessName, businessType, apiKey,
    notificationChannel: 'line',
    ...(timezone ? { timezone } : {}),
  };
  await env.STORES.put(`store:${storeId}`, JSON.stringify(store));

  return withCors(json({ ok: true, storeId, apiKey }));
}

// ── /admin/stores ─────────────────────────────────────────────────────────────

function checkAdminAuth(request, env) {
  const key = request.headers.get('X-Admin-Key') ?? '';
  return env.ADMIN_KEY && key === env.ADMIN_KEY;
}

async function handleAdminPut(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

  const {
    lineChannelToken, lineUserId,
    telegramBotToken, telegramChatId,
    businessName, businessType, apiKey,
    notificationChannel, timezone, notifyMode, webhookSecret,
    utcOffset,
  } = body ?? {};

  if (!apiKey) return jsonError('apiKey is required', 400);
  const channel = notificationChannel ?? 'line';
  if (channel === 'line' && (!lineChannelToken || !lineUserId)) {
    return jsonError('lineChannelToken and lineUserId are required for line channel', 400);
  }
  if (channel === 'telegram' && (!telegramBotToken || !telegramChatId)) {
    return jsonError('telegramBotToken and telegramChatId are required for telegram channel', 400);
  }

  const store = {
    apiKey, businessName, businessType, notificationChannel: channel,
    ...(timezone ? { timezone } : {}),
    ...(notifyMode ? { notifyMode } : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(utcOffset !== undefined ? { utcOffset: Number(utcOffset) } : {}),
    ...(lineChannelToken ? { lineChannelToken } : {}),
    ...(lineUserId ? { lineUserId } : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
  };
  await env.STORES.put(`store:${storeId}`, JSON.stringify(store));
  return json({ ok: true, storeId });
}

async function handleAdminDelete(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);
  await Promise.all([
    env.STORES.delete(`store:${storeId}`),
    env.STORES.delete(`pending:${storeId}`),
  ]);
  return json({ ok: true, storeId, deleted: true });
}

async function handleAdminStatus(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);

  const [storeRaw, pendingRaw] = await Promise.all([
    env.STORES.get(`store:${storeId}`),
    env.STORES.get(`pending:${storeId}`),
  ]);

  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);

  const store = JSON.parse(storeRaw);
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];

  return json({
    ok: true,
    storeId,
    businessName: store.businessName ?? null,
    businessType: store.businessType ?? null,
    notificationChannel: store.notificationChannel ?? 'line',
    notifyMode: store.notifyMode ?? 'immediate',
    utcOffset: store.utcOffset ?? 9,
    hasPending: pending.length > 0,
    pendingCount: pending.length,
    hasWebhookSecret: Boolean(store.webhookSecret),
  });
}

async function handleNotifyTest(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);
  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);
  const store = JSON.parse(storeRaw);

  const testReview = {
    star: 5,
    text: 'MEO Harness テスト通知。この通知が届いていれば設定完了です。\nMEO Harness test notification — configuration successful.',
    name: 'MEO Harness',
    draft: '[テスト返信] ご確認いただきありがとうございます。',
  };

  const result = await sendDigest({ store, reviews: [testReview] });
  return json({ ok: true, storeId, channel: store.notificationChannel ?? 'line', notify: result });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function jsonError(message, status) {
  return json({ error: message }, status);
}

function withCors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}

function corsPreflight() {
  return withCors(new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  }));
}
