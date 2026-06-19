#!/usr/bin/env node
/**
 * setup-telegram.mjs — Telegram Bot 設定 & E2E スモークテスト
 *
 * 前提: TELEGRAM_BOT_TOKEN が環境変数にセットされていること。
 *   source ~/.config/ai-keys/load.sh && node scripts/setup-telegram.mjs
 *
 * 手順:
 *   Step 1. Telegram でボットを作成する（BotFather）
 *   Step 2. このスクリプトを実行してチャット ID を自動取得
 *   Step 3. 資格情報を Keychain に保存
 *   Step 4. Worker に Telegram 店舗を登録して本番テスト
 *
 * ─── BotFather でボットを作る手順 ───
 *   1. Telegram で @BotFather を開く（スマホ / Telegram Web / デスクトップ）
 *   2. /newbot を送信
 *   3. ボット名（例: MEO Harness Notify）を入力
 *   4. ユーザー名（例: meo_harness_notify_bot）を入力 ← 末尾が _bot 必須
 *   5. 発行されたトークン（110桁前後の文字列）をコピー
 *   6. 以下のコマンドで Keychain に保存:
 *      security add-generic-password -a "$USER" -s TELEGRAM_BOT_TOKEN -w 'ここにトークン' -U
 *   7. ボットのチャットを開いて「/start」を送信
 *   8. このスクリプトを再実行 → チャット ID を自動取得
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = 'https://api.telegram.org';

if (!BOT_TOKEN) {
  console.error([
    '',
    '❌ TELEGRAM_BOT_TOKEN が見つかりません。',
    '',
    '  手順:',
    '  1. Telegram で @BotFather を開き /newbot でボットを作成',
    '  2. 発行されたトークンを Keychain に保存:',
    '     security add-generic-password -a "$USER" -s TELEGRAM_BOT_TOKEN -w \'YOUR_TOKEN_HERE\' -U',
    '  3. load.sh に TELEGRAM_BOT_TOKEN を追記（下記参照）',
    '  4. ボットに /start を送信してから再実行',
    '',
    '  ~/.config/ai-keys/load.sh に追記する行:',
    '    TELEGRAM_BOT_TOKEN \\',
    '    TELEGRAM_CHAT_ID \\',
    '',
  ].join('\n'));
  process.exit(1);
}

async function apiCall(method, params = {}) {
  const url = `${BASE_URL}/bot${BOT_TOKEN}/${method}`;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url);
  return res.json();
}

// ── Step 1: ボット情報確認 ───────────────────────────────────────────────────
console.log('\n🤖 Telegram Bot 設定スクリプト\n');
const meRes = await apiCall('getMe');
if (!meRes.ok) {
  console.error('❌ getMe 失敗:', JSON.stringify(meRes));
  process.exit(1);
}
const { username, first_name } = meRes.result;
console.log(`✅ ボット認証成功: ${first_name} (@${username})`);

// ── Step 2: チャット ID 取得（直近のメッセージから自動発見）────────────────────
const updatesRes = await apiCall('getUpdates', { limit: 10, allowed_updates: 'message' });
if (!updatesRes.ok) {
  console.error('❌ getUpdates 失敗:', JSON.stringify(updatesRes));
  process.exit(1);
}

const existingChatId = process.env.TELEGRAM_CHAT_ID;
let chatId = existingChatId;

if (!chatId) {
  const messages = updatesRes.result ?? [];
  if (!messages.length) {
    console.error([
      '',
      '⚠️  まだメッセージがありません。',
      `   Telegram で @${username} を開いて「/start」を送信してから再実行してください。`,
      '',
    ].join('\n'));
    process.exit(1);
  }
  chatId = String(messages[messages.length - 1]?.message?.chat?.id ?? '');
  if (!chatId) {
    console.error('❌ チャット ID を抽出できませんでした。メッセージ一覧:', JSON.stringify(messages.slice(-2)));
    process.exit(1);
  }
  console.log(`\n✅ チャット ID を自動取得: ${chatId}`);
  console.log('\n  Keychain に保存するコマンド（自分で実行してください）:');
  console.log(`  security add-generic-password -a "$USER" -s TELEGRAM_CHAT_ID -w '${chatId}' -U`);
  console.log('  # load.sh に TELEGRAM_CHAT_ID を追記してから再実行');
} else {
  console.log(`✅ チャット ID（Keychain 取得済み）: ${chatId}`);
}

// ── Step 3: テストメッセージ送信 ─────────────────────────────────────────────
const testText = [
  '🎉 MEO Harness セットアップ完了テスト',
  '',
  '✅ この通知が届いていれば Telegram チャネルの設定は完了です。',
  '',
  '店舗を Worker に登録するコマンド例:',
  '  node scripts/register-telegram-store.mjs',
].join('\n');

const sendRes = await apiCall('sendMessage', { chat_id: chatId, text: testText });
if (!sendRes.ok) {
  console.error('❌ sendMessage 失敗:', JSON.stringify(sendRes));
  process.exit(1);
}
console.log('\n✅ Telegram テストメッセージを送信しました。スマホ/Telegram で確認してください。');
console.log('\n── 次のステップ ───────────────────────────────────────────────');
console.log('1. Keychain に TELEGRAM_CHAT_ID を保存（上記のコマンド）');
console.log('2. ~/.config/ai-keys/load.sh に TELEGRAM_BOT_TOKEN と TELEGRAM_CHAT_ID を追記');
console.log('3. Worker に Telegram 店舗を登録:');
console.log('   source ~/.config/ai-keys/load.sh && node scripts/register-telegram-store.mjs');
console.log('4. テスト通知で E2E 確認:');
console.log('   curl -s -X POST https://meo-harness.yosinn1.workers.dev/admin/stores/<storeId>/notify/test \\');
console.log('     -H "X-Admin-Key: $MEO_HARNESS_ADMIN_KEY"');
