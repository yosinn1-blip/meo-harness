// MEO Harness — 中央窓口 Cloudflare Worker (step3 / d)
//
// エンドポイント:
//   GET  /health                  — ヘルスチェック
//   POST /review                  — 口コミ→AI下書き→LINE通知（X-API-Key: store.apiKey）
//   POST /signup                  — 設置ウィザード用・公開エンドポイント。LINE認証情報を検証のうえ
//                                    storeId/apiKeyをサーバー側で生成してKVに登録（ADMIN_KEY不要）
//   PUT  /admin/stores/:storeId   — 店舗設定を KV に登録（X-Admin-Key: ADMIN_KEY）
//   DELETE /admin/stores/:storeId — 店舗設定を KV から削除（X-Admin-Key: ADMIN_KEY）
//
// KV スキーマ:
//   key: "store:{storeId}"
//   val: {
//     apiKey, businessName, businessType,
//     notificationChannel: 'line' | 'telegram'  (省略時 → 'line')
//     -- LINE --
//     lineChannelToken, lineUserId,
//     -- Telegram --
//     telegramBotToken, telegramChatId,
//     -- オプション --
//     timezone: string  (例: 'Asia/Tokyo', 'America/New_York'。ダイジスト送信タイミング用・将来使用)
//   }
//
// Secrets（.dev.vars / Workers Secrets）:
//   GROQ_API_KEY — Groq API キー（Yoshiki 所有、無料枠。MVP は1本で吸収）
//   ADMIN_KEY    — 管理エンドポイント認証
//
// セキュリティ方針:
//   /signup は不特定多数のブラウザから呼ばれる公開エンドポイントのため ADMIN_KEY は
//   一切要求しない（公開ページのJSに秘密鍵を置くと丸見えになるため）。代わりに
//   storeId/apiKeyをWorker側で生成し、登録前にLINE Profile APIで認証情報の有効性を検証する。

import { generateReply, PROVIDERS } from '../src/reply-engine.mjs';
import { verifyLineCredentials } from '../src/line-notify.mjs';
import { sendDigest } from '../src/notify.mjs';

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

      if (path === '/signup') {
        if (method === 'OPTIONS') return corsPreflight();
        if (method === 'POST') return await handleSignup(request, env);
      }

      if (path.startsWith('/admin/stores/')) {
        const storeId = path.slice('/admin/stores/'.length);
        if (!storeId) return jsonError('storeId is required in path', 400);
        if (method === 'PUT') return await handleAdminPut(request, env, storeId);
        if (method === 'DELETE') return await handleAdminDelete(request, env, storeId);
      }

      return jsonError('Not Found', 404);
    } catch (err) {
      return jsonError(`Internal Error: ${err.message}`, 500);
    }
  },
};

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

  const { lineChannelToken, lineUserId, businessName, businessType } = store;

  // AI 下書き生成（並列・best-effort）
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

  // 通知送信（notificationChannel に応じてチャネルを選択）
  let notifyResult;
  try {
    notifyResult = await sendDigest({ store, reviews: processed });
  } catch (err) {
    return json({
      ok: false,
      processed: processed.length,
      failed,
      source: reviewSource ?? 'unknown',
      notifyError: err.message,
      reviews: processed,
    });
  }

  return json({ ok: true, processed: processed.length, failed, source: reviewSource ?? 'unknown', notify: notifyResult });
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
    notificationChannel, timezone,
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
  await env.STORES.delete(`store:${storeId}`);
  return json({ ok: true, storeId, deleted: true });
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

// /signup はブラウザの設置ウィザード（別オリジン）から呼ばれるためCORSが必要。
// クッキー等の認証情報を伴わない公開POSTなので Allow-Origin: * で問題ない。
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
