// MEO Harness — 中央窓口 Cloudflare Worker
//
// エンドポイント:
//   GET  /health                              — ヘルスチェック
//   POST /review                              — 口コミ→AI下書き→通知（X-API-Key: store.apiKey）
//   POST /webhook/:platform                   — 外部 Webhook（Yelp/Trustpilot/Yahoo!プレイス）
//   POST /webhook/line-bot                    — LINE Messaging API Webhook（postback処理）
//   POST /signup                              — 設置ウィザード用・公開エンドポイント
//   GET  /admin/stores/:storeId/status        — 店舗ステータス確認（X-Admin-Key: ADMIN_KEY）
//   PUT  /admin/stores/:storeId               — 店舗設定を KV に登録（X-Admin-Key: ADMIN_KEY）
//   DELETE /admin/stores/:storeId             — 店舗設定を KV から削除（X-Admin-Key: ADMIN_KEY）
//   POST /admin/stores/:storeId/notify/test   — テスト通知を送信（X-Admin-Key: ADMIN_KEY）
//
// KV スキーマ:
//   "store:{storeId}"    — 店舗設定（apiKey, businessName, 通知チャネル情報, GBP情報 等）
//   "pending:{storeId}"  — daily-digest バッファ（7日 TTL）
//   "reply:{uuid}"       — GBP 返信承認待ちデータ（7日 TTL）
//   "gbp-last:{storeId}" — GBP ポーリング最終確認日時（ISO文字列）
//
// Worker Secrets:
//   GROQ_API_KEY             — Groq API キー
//   ADMIN_KEY                — 管理エンドポイント認証
//   GBP_OAUTH_CLIENT_ID      — Google OAuth クライアント ID
//   GBP_OAUTH_CLIENT_SECRET  — Google OAuth クライアントシークレット
//   LINE_CHANNEL_SECRET      — LINE Bot チャネルシークレット（Webhook 署名検証用）
//   WHATSAPP_TOKEN           — Meta System User Token（Meta Business Manager）
//   WHATSAPP_PHONE_NUMBER_ID — WhatsApp 送信元電話番号 ID
//   WHATSAPP_VERIFY_TOKEN    — WhatsApp Webhook 検証トークン（任意文字列）

import { generateReply, PROVIDERS } from '../src/reply-engine.mjs';
import { verifyLineCredentials } from '../src/line-notify.mjs';
import { sendDigest } from '../src/notify.mjs';
import { mergePendingReviews, shouldSendDigest, isDigestHour } from '../src/cron.mjs';

export default {
  async fetch(request, env, ctx) {
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

      // LINE Bot Webhook（platform ルートより前に評価）
      if (method === 'POST' && path === '/webhook/line-bot') {
        return await handleLineBotWebhook(request, env, ctx);
      }

      // WhatsApp Webhook（platform ルートより前に評価）
      if (path === '/webhook/whatsapp') {
        if (method === 'GET') return handleWhatsAppVerify(url, env);
        if (method === 'POST') return await handleWhatsAppWebhook(request, env, ctx);
      }

      // GBP OAuth フロー
      if (method === 'GET' && path === '/gbp/oauth/callback') {
        return await handleGbpOAuthCallback(url, env);
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

        if (rest.endsWith('/gbp/oauth/start')) {
          const storeId = rest.slice(0, -'/gbp/oauth/start'.length);
          if (method === 'POST') return await handleGbpOAuthStart(request, env, storeId);
        }

        if (rest.endsWith('/gbp/locations')) {
          const storeId = rest.slice(0, -'/gbp/locations'.length);
          if (method === 'GET') return await handleGbpLocations(request, env, storeId);
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

    // ① daily-digest バッファを吐き出す
    const pendingList = await env.STORES.list({ prefix: 'pending:' });
    if (pendingList.keys.length) {
      const digestResults = await Promise.allSettled(
        pendingList.keys.map(({ name: key }) => handlePendingStore(key, env, utcHour))
      );
      digestResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[cron/digest] failed for ${pendingList.keys[i].name}:`, r.reason?.message);
        }
      });
    }

    // ② GBP ポーリング（gbpRefreshToken が設定された店舗のみ）
    const storeList = await env.STORES.list({ prefix: 'store:' });
    if (storeList.keys.length) {
      const pollResults = await Promise.allSettled(
        storeList.keys.map(({ name: key }) => pollGbpStore(key, env))
      );
      pollResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[cron/gbp] failed for ${storeList.keys[i].name}:`, r.reason?.message);
        }
      });
    }

    // ③ Gmail 経由 GBP クチコミ監視（GBP API 承認待ちのブリッジ）
    if (env.GMAIL_REFRESH_TOKEN && env.GBP_OAUTH_CLIENT_ID && env.GBP_OAUTH_CLIENT_SECRET) {
      try {
        await pollGmailReviews(env);
      } catch (err) {
        console.error('[cron/gmail] failed:', err.message);
      }
    }
  },
};

// ── GBP ポーリング（Cron から呼び出し） ─────────────────────────────────────

async function pollGbpStore(storeKey, env) {
  const storeRaw = await env.STORES.get(storeKey);
  if (!storeRaw) return;
  const store = JSON.parse(storeRaw);

  const { gbpRefreshToken, gbpAccountId, gbpLocationId } = store;
  if (!gbpRefreshToken || !gbpAccountId || !gbpLocationId) return;
  if (!env.GBP_OAUTH_CLIENT_ID || !env.GBP_OAUTH_CLIENT_SECRET) return;

  const storeId = storeKey.slice('store:'.length);
  const { getGbpAccessToken, fetchGbpReviews, normalizeGbpReview } = await import('../src/gbp.mjs');

  const accessToken = await getGbpAccessToken({
    clientId: env.GBP_OAUTH_CLIENT_ID,
    clientSecret: env.GBP_OAUTH_CLIENT_SECRET,
    refreshToken: gbpRefreshToken,
  });

  const rawReviews = await fetchGbpReviews({ accessToken, accountId: gbpAccountId, locationId: gbpLocationId });

  // 返信済みを除外 + 前回ポーリング以降の新着のみ
  const lastRaw = await env.STORES.get(`gbp-last:${storeId}`);
  const lastSeen = lastRaw ? new Date(lastRaw) : new Date(0);

  const newReviews = rawReviews
    .filter(r => !r.reviewReply)
    .map(normalizeGbpReview)
    .filter(r => new Date(r.createTime) > lastSeen);

  if (!newReviews.length) return;

  await processReviews(newReviews, store, storeId, env);

  // 最新の createTime を記録
  const latest = newReviews.reduce((a, b) =>
    new Date(a.createTime) > new Date(b.createTime) ? a : b
  );
  await env.STORES.put(`gbp-last:${storeId}`, latest.createTime);
}

// ── Gmail 経由 GBP クチコミ監視（Cron から呼び出し） ─────────────────────────

async function pollGmailReviews(env) {
  const { fetchReviewNotificationEmails, parseGbpReviewEmail } = await import('../src/gmail-reviews.mjs');

  const lastRaw = await env.STORES.get('gmail-last:global');
  const lastDate = lastRaw
    ? new Date(lastRaw)
    : new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const emails = await fetchReviewNotificationEmails({
    clientId: env.GBP_OAUTH_CLIENT_ID,
    clientSecret: env.GBP_OAUTH_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
  });

  const newEmails = emails.filter((e) => {
    const d = new Date(e.date);
    return !isNaN(d.getTime()) && d > lastDate;
  });

  if (!newEmails.length) return;

  // 全ストアを取得して businessName でマッチング
  const storeList = await env.STORES.list({ prefix: 'store:' });
  const stores = [];
  for (const { name: key } of storeList.keys) {
    const raw = await env.STORES.get(key);
    if (raw) stores.push({ store: JSON.parse(raw), storeId: key.slice('store:'.length) });
  }
  if (!stores.length) return;

  for (const email of newEmails) {
    const parsed = parseGbpReviewEmail(email);
    if (!parsed) continue;

    const match =
      stores.find((s) => s.store.businessName === parsed.businessName) ?? stores[0];
    if (!match) continue;

    const review = {
      platform: 'gbp-mail',
      star: parsed.star,
      text: parsed.text ?? parsed.rawText,
      name: parsed.name ?? 'Unknown',
    };

    await processReviews([review], match.store, match.storeId, env).catch((err) => {
      console.error(`[cron/gmail] processReviews failed for ${match.storeId}:`, err.message);
    });
  }

  // 最新メールの日時を記録
  const latestDate = newEmails
    .map((e) => new Date(e.date))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => b - a)[0];
  if (latestDate) {
    await env.STORES.put('gmail-last:global', latestDate.toISOString());
  }
}

// ── 共通パイプライン ──────────────────────────────────────────────────────────

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

  // GBP 由来のレビューは reply:{uuid} エントリを作成してボタン付き Flex Message を送る
  const processedWithReplyIds = await Promise.all(
    processed.map(async review => {
      if (!review.reviewId) return review;
      const replyId = crypto.randomUUID();
      await env.STORES.put(`reply:${replyId}`, JSON.stringify({
        storeId,
        reviewId: review.reviewId,
        draft: review.draft,
        gbpAccountId: store.gbpAccountId,
        gbpLocationId: store.gbpLocationId,
        star: review.star,
        text: review.text,
        name: review.name,
      }), { expirationTtl: 7 * 24 * 3600 });
      return { ...review, replyId };
    })
  );

  if (shouldSendDigest(store)) {
    const existingRaw = await env.STORES.get(`pending:${storeId}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const merged = mergePendingReviews(existing, processedWithReplyIds);
    await env.STORES.put(`pending:${storeId}`, JSON.stringify(merged), { expirationTtl: 7 * 24 * 3600 });
    return { buffered: true, count: merged.length };
  }

  const notifyResult = await sendDigest({ store: withEnvCredentials(store, env), reviews: processedWithReplyIds });
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

  await sendDigest({ store: withEnvCredentials(store, env), reviews: processed });
  await env.STORES.delete(pendingKey);
}

// ── /webhook/line-bot（LINE Messaging API Webhook） ───────────────────────────

async function handleLineBotWebhook(request, env, ctx) {
  const body = await request.text();
  const signature = request.headers.get('X-Line-Signature') ?? '';

  if (env.LINE_CHANNEL_SECRET) {
    const { verifyLineSignature } = await import('../src/hmac.mjs');
    const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, signature);
    if (!valid) return jsonError('Invalid LINE signature', 401);
  }

  let events;
  try { events = JSON.parse(body).events ?? []; }
  catch { return jsonError('Invalid JSON', 400); }

  // LINE は 1 秒以内の 200 レスポンスを要求するため、処理を waitUntil に移す
  ctx.waitUntil(processLineEvents(events, env));
  return json({ ok: true });
}

async function processLineEvents(events, env) {
  for (const event of events) {
    if (event.type !== 'postback') continue;
    try {
      await handleLinePostback(event, env);
    } catch (err) {
      console.error('[line-postback] error:', err.message);
    }
  }
}

async function handleLinePostback(event, env) {
  const data = event.postback?.data ?? '';
  const colonIdx = data.indexOf(':');
  if (colonIdx === -1) return;

  const action = data.slice(0, colonIdx);
  const replyId = data.slice(colonIdx + 1);
  if (!replyId || replyId === 'none') return;

  const replyRaw = await env.STORES.get(`reply:${replyId}`);
  if (!replyRaw) return;

  await env.STORES.delete(`reply:${replyId}`);
  if (action === 'skip') return;

  if (action === 'approve') {
    const reply = JSON.parse(replyRaw);
    const { storeId, reviewId, draft, gbpAccountId, gbpLocationId } = reply;

    const storeRaw = await env.STORES.get(`store:${storeId}`);
    if (!storeRaw) return;
    const store = JSON.parse(storeRaw);

    const { getGbpAccessToken, postGbpReply } = await import('../src/gbp.mjs');
    const accessToken = await getGbpAccessToken({
      clientId: env.GBP_OAUTH_CLIENT_ID,
      clientSecret: env.GBP_OAUTH_CLIENT_SECRET,
      refreshToken: store.gbpRefreshToken,
    });
    await postGbpReply({ accessToken, accountId: gbpAccountId, locationId: gbpLocationId, reviewId, comment: draft });

    // LINE に完了通知を返す
    const userId = event.source?.userId;
    if (userId && store.lineChannelToken) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${store.lineChannelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: 'text', text: '✅ Google に返信を投稿しました！' }],
        }),
      });
    }
  }
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

async function handleAdminStatus(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);

  const [storeRaw, pendingRaw] = await Promise.all([
    env.STORES.get(`store:${storeId}`),
    env.STORES.get(`pending:${storeId}`),
  ]);

  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);

  const store = JSON.parse(storeRaw);
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  const lastGbpPoll = await env.STORES.get(`gbp-last:${storeId}`);

  return json({
    ok: true,
    storeId,
    businessName: store.businessName ?? null,
    businessType: store.businessType ?? null,
    notificationChannel: store.notificationChannel ?? 'line',
    notifyMode: store.notifyMode ?? 'immediate',
    utcOffset: store.utcOffset ?? 9,
    hasGbpConfig: Boolean(store.gbpRefreshToken && store.gbpAccountId && store.gbpLocationId),
    hasWhatsAppConfig: Boolean(store.whatsappRecipient),
    lastGbpPoll: lastGbpPoll ?? null,
    hasPending: pending.length > 0,
    pendingCount: pending.length,
    hasWebhookSecret: Boolean(store.webhookSecret),
  });
}

async function handleAdminPut(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

  const {
    lineChannelToken, lineUserId,
    telegramBotToken, telegramChatId,
    whatsappRecipient, whatsappTemplateName, whatsappTemplateLang,
    gbpRefreshToken, gbpAccountId, gbpLocationId,
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
  if (channel === 'whatsapp' && !whatsappRecipient) {
    return jsonError('whatsappRecipient is required for whatsapp channel', 400);
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
    ...(whatsappRecipient ? { whatsappRecipient } : {}),
    ...(whatsappTemplateName ? { whatsappTemplateName } : {}),
    ...(whatsappTemplateLang ? { whatsappTemplateLang } : {}),
    ...(gbpRefreshToken ? { gbpRefreshToken } : {}),
    ...(gbpAccountId ? { gbpAccountId } : {}),
    ...(gbpLocationId ? { gbpLocationId } : {}),
  };
  await env.STORES.put(`store:${storeId}`, JSON.stringify(store));
  return json({ ok: true, storeId });
}

async function handleAdminDelete(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);
  await Promise.all([
    env.STORES.delete(`store:${storeId}`),
    env.STORES.delete(`pending:${storeId}`),
    env.STORES.delete(`gbp-last:${storeId}`),
  ]);
  return json({ ok: true, storeId, deleted: true });
}

// ── /webhook/whatsapp ─────────────────────────────────────────────────────────

function handleWhatsAppVerify(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return jsonError('Webhook verification failed', 403);
}

async function handleWhatsAppWebhook(request, env, ctx) {
  // Meta は 200 を素早く返すことを要求するため、処理を waitUntil に移す
  ctx.waitUntil(processWhatsAppEvents(request));
  return json({ ok: true });
}

async function processWhatsAppEvents(request) {
  let body;
  try { body = await request.json(); } catch { return; }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        console.log(`[whatsapp] message ${s.id} → ${s.status} (${s.recipient_id ?? ''})`);
      }
    }
  }
}

// ── GBP OAuth フロー ──────────────────────────────────────────────────────────
//
// 使い方:
//   1. POST /admin/stores/:storeId/gbp/oauth/start  → { oauthUrl }
//   2. オーナーがブラウザで oauthUrl を開く
//   3. Google 認証後 → /gbp/oauth/callback に戻ってくる（自動）
//   4. refresh_token が store KV に保存される
//
// 前提: GBP_OAUTH_CLIENT_ID / GBP_OAUTH_CLIENT_SECRET が Worker Secret に設定済み

const GBP_OAUTH_SCOPES = 'https://www.googleapis.com/auth/business.manage';
const GBP_OAUTH_STATE_TTL = 600; // 10分

async function handleGbpOAuthStart(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);
  if (!env.GBP_OAUTH_CLIENT_ID) return jsonError('GBP_OAUTH_CLIENT_ID が未設定です', 500);

  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);

  // state トークン（storeId の代理。KV に10分保存）
  const state = crypto.randomUUID();
  await env.STORES.put(`gbp-oauth-state:${state}`, storeId, { expirationTtl: GBP_OAUTH_STATE_TTL });

  const reqUrl = new URL(request.url);
  const redirectUri = `${reqUrl.origin}/gbp/oauth/callback`;

  const params = new URLSearchParams({
    client_id: env.GBP_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GBP_OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return json({ ok: true, storeId, oauthUrl, expiresIn: GBP_OAUTH_STATE_TTL });
}

async function handleGbpOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return htmlPage('GBP 認証エラー', `<p>Google 認証が拒否されました: <code>${error}</code></p>`, 400);
  if (!code || !state) return htmlPage('GBP 認証エラー', '<p>code または state が不正です</p>', 400);

  const storeId = await env.STORES.get(`gbp-oauth-state:${state}`);
  if (!storeId) return htmlPage('GBP 認証エラー', '<p>state が期限切れまたは無効です（10分以内に再度 OAuth を開始してください）</p>', 400);

  await env.STORES.delete(`gbp-oauth-state:${state}`);

  if (!env.GBP_OAUTH_CLIENT_ID || !env.GBP_OAUTH_CLIENT_SECRET) {
    return htmlPage('設定エラー', '<p>GBP_OAUTH_CLIENT_ID / CLIENT_SECRET が未設定です</p>', 500);
  }

  const redirectUri = `${url.origin}/gbp/oauth/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GBP_OAUTH_CLIENT_ID,
      client_secret: env.GBP_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.refresh_token) {
    const msg = tokenData.error_description ?? tokenData.error ?? JSON.stringify(tokenData).slice(0, 200);
    return htmlPage('トークン取得エラー', `<p>${msg}</p><p>refresh_token が返されませんでした。Google Cloud Console で「offline アクセス」が有効か確認してください。</p>`, 500);
  }

  // refresh_token を store に保存
  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return htmlPage('エラー', `<p>store:${storeId} が見つかりません</p>`, 404);
  const store = JSON.parse(storeRaw);
  store.gbpRefreshToken = tokenData.refresh_token;
  await env.STORES.put(`store:${storeId}`, JSON.stringify(store));

  return htmlPage(
    'GBP 認証完了',
    `<p>✅ Google ビジネスプロフィールの認証が完了しました。</p>
     <p>店舗 ID: <code>${storeId}</code></p>
     <p>次のステップ: <code>GET /admin/stores/${storeId}/gbp/locations</code> で店舗を選択してください。</p>`,
    200,
  );
}

async function handleGbpLocations(request, env, storeId) {
  if (!checkAdminAuth(request, env)) return jsonError('Unauthorized', 401);

  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);
  const store = JSON.parse(storeRaw);
  if (!store.gbpRefreshToken) return jsonError('GBP OAuth 未完了（/gbp/oauth/start から開始してください）', 400);

  const { getGbpAccessToken, listGbpAccounts, listGbpLocations } = await import('../src/gbp.mjs');
  const accessToken = await getGbpAccessToken({
    clientId: env.GBP_OAUTH_CLIENT_ID,
    clientSecret: env.GBP_OAUTH_CLIENT_SECRET,
    refreshToken: store.gbpRefreshToken,
  });

  const accounts = await listGbpAccounts({ accessToken });
  const locationsByAccount = await Promise.all(
    accounts.map(async (account) => {
      const locations = await listGbpLocations({ accessToken, accountId: account.name }).catch(() => []);
      return { account: { name: account.name, accountName: account.accountName }, locations };
    }),
  );

  return json({ ok: true, storeId, locationsByAccount });
}

// ── helpers ───────────────────────────────────────────────────────────────────

// WhatsApp Token / Phone Number ID は Worker Secret なので
// store KV に保存せず、sendDigest 呼び出し時に env から注入する。
function withEnvCredentials(store, env) {
  return {
    ...store,
    whatsappToken: env.WHATSAPP_TOKEN,
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

async function handleAdminStatus_unused() {} // eslint dead code removal guard

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

  const result = await sendDigest({ store: withEnvCredentials(store, env), reviews: [testReview] });
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

function htmlPage(title, bodyHtml, status = 200) {
  return new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${title}</title>
     <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px;line-height:1.6}</style>
     </head><body><h1>${title}</h1>${bodyHtml}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
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
