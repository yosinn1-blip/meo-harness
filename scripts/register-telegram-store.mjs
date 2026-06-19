#!/usr/bin/env node
/**
 * register-telegram-store.mjs — Telegram チャネルの店舗を本番 Worker に登録
 *
 * 使い方:
 *   source ~/.config/ai-keys/load.sh && node scripts/register-telegram-store.mjs
 *
 * 必要な環境変数（Keychain から load.sh 経由で取得）:
 *   TELEGRAM_BOT_TOKEN   — BotFather から取得したトークン
 *   TELEGRAM_CHAT_ID     — setup-telegram.mjs で自動取得したチャット ID
 *   MEO_HARNESS_ADMIN_KEY
 */

const WORKER_URL = 'https://meo-harness.yosinn1.workers.dev';
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MEO_HARNESS_ADMIN_KEY } = process.env;

const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'MEO_HARNESS_ADMIN_KEY']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ 環境変数が不足: ${missing.join(', ')}`);
  console.error('   source ~/.config/ai-keys/load.sh を実行してから再試行してください。');
  process.exit(1);
}

const storeId = 'telegram-test';
const apiKey = crypto.randomUUID();

console.log(`\n📡 Worker に Telegram 店舗を登録: storeId="${storeId}"`);

const res = await fetch(`${WORKER_URL}/admin/stores/${storeId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': MEO_HARNESS_ADMIN_KEY },
  body: JSON.stringify({
    apiKey,
    businessName: 'Telegram テスト店舗',
    businessType: 'テスト',
    notificationChannel: 'telegram',
    telegramBotToken: TELEGRAM_BOT_TOKEN,
    telegramChatId: TELEGRAM_CHAT_ID,
    utcOffset: 9,
  }),
});
const data = await res.json();

if (!data.ok) {
  console.error('❌ 登録失敗:', JSON.stringify(data));
  process.exit(1);
}
console.log(`✅ 登録成功: storeId="${storeId}", apiKey="${apiKey}"`);

// テスト通知を送信
console.log('\n📨 テスト通知を送信中...');
const testRes = await fetch(`${WORKER_URL}/admin/stores/${storeId}/notify/test`, {
  method: 'POST',
  headers: { 'X-Admin-Key': MEO_HARNESS_ADMIN_KEY },
});
const testData = await testRes.json();
if (testData.ok) {
  console.log('✅ Telegram テスト通知を送信しました。Telegram で確認してください。');
  console.log('   結果:', JSON.stringify(testData.notify, null, 2));
} else {
  console.error('❌ テスト通知失敗:', JSON.stringify(testData));
}

console.log('\n── 店舗情報（.dev.vars に追記する場合） ──────────────');
console.log(`TELEGRAM_TEST_STORE_ID=${storeId}`);
console.log(`TELEGRAM_TEST_API_KEY=${apiKey}`);
