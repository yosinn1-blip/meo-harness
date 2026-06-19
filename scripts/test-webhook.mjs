#!/usr/bin/env node
/**
 * test-webhook.mjs — Yelp / Trustpilot Webhook の E2E テスト
 *
 * 使い方:
 *   source ~/.config/ai-keys/load.sh && node scripts/test-webhook.mjs [yelp|trustpilot|all]
 *
 * 前提:
 *   - 対象店舗に webhookSecret が設定済みであること（PUT /admin/stores/:id で設定）
 *   - WEBHOOK_TEST_SECRET 環境変数 または --secret オプションで指定
 *   - 店舗 ID は --store オプションで変更可（デフォルト: yoshiki-apps）
 */

import { createHmac } from 'node:crypto';

const WORKER_URL = 'https://meo-harness.yosinn1.workers.dev';

const args = process.argv.slice(2);
const platform = args.find(a => ['yelp', 'trustpilot', 'all'].includes(a)) ?? 'all';
const storeId = args.find(a => a.startsWith('--store='))?.slice('--store='.length) ?? 'yoshiki-apps';
const secretArg = args.find(a => a.startsWith('--secret='))?.slice('--secret='.length);
const secret = secretArg ?? process.env.WEBHOOK_TEST_SECRET;

if (!secret) {
  console.error('❌ WEBHOOK_TEST_SECRET 環境変数か --secret=<値> が必要です。');
  console.error('   store に設定したのと同じ webhookSecret を渡してください。');
  process.exit(1);
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function sendWebhook(platform, payload) {
  const body = JSON.stringify(payload);
  const sig = sign(secret, body);
  const res = await fetch(`${WORKER_URL}/webhook/${platform}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Store-Id': storeId,
      'X-Webhook-Secret': sig,
    },
    body,
  });
  return { status: res.status, data: await res.json() };
}

console.log(`\n🔗 Webhook E2E テスト: store="${storeId}"\n`);

// ── Yelp ─────────────────────────────────────────────────────────────────────
const yelpPayload = {
  event_type: 'new_review',
  data: {
    id: 'yelp-test-001',
    rating: 5,
    text: 'Excellent service! The AI-powered response was incredibly helpful and personalized.',
    user: { name: 'Test Reviewer' },
  },
};

// ── Trustpilot ────────────────────────────────────────────────────────────────
const trustpilotPayload = {
  event_type: 'review.created',
  review: {
    id: 'tp-test-001',
    stars: 4,
    title: 'Great tool for review management',
    text: 'Very useful for automating review responses. Would recommend to local businesses.',
    consumer: { displayName: 'TP Tester' },
  },
};

const tests = [];
if (platform === 'yelp' || platform === 'all') tests.push({ platform: 'yelp', payload: yelpPayload });
if (platform === 'trustpilot' || platform === 'all') tests.push({ platform: 'trustpilot', payload: trustpilotPayload });

for (const { platform: p, payload } of tests) {
  process.stdout.write(`  [${p}] 送信中...`);
  try {
    const { status, data } = await sendWebhook(p, payload);
    if (data.ok) {
      console.log(` ✅ ${status} ok`);
      if (data.buffered) console.log(`       → daily-digest バッファ（${data.count}件）`);
      if (data.processed) console.log(`       → 処理 ${data.processed}件, 失敗 ${data.failed}件`);
    } else {
      console.log(` ❌ ${status} ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.log(` ❌ ネットワークエラー: ${err.message}`);
  }
}

// ── 不正署名のテスト ───────────────────────────────────────────────────────────
console.log('\n  [security] 不正署名で 401 が返ることを確認...');
const res = await fetch(`${WORKER_URL}/webhook/yelp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Store-Id': storeId,
    'X-Webhook-Secret': 'invalidsignature',
  },
  body: JSON.stringify(yelpPayload),
});
const secData = await res.json();
if (res.status === 401) {
  console.log('  ✅ 401 Unauthorized — 正しく拒否されました');
} else {
  console.log(`  ❌ 期待値 401, 実際 ${res.status}: ${JSON.stringify(secData)}`);
}

console.log('\n✅ Webhook E2E テスト完了\n');
