#!/usr/bin/env node
/**
 * setup-gbp-oauth.mjs — Google Business Profile API の OAuth 認証
 *
 * 使い方:
 *   source ~/.config/ai-keys/load.sh && node scripts/setup-gbp-oauth.mjs
 *
 * 必要な環境変数（Keychain から load.sh 経由で取得）:
 *   GBP_OAUTH_CLIENT_ID
 *   GBP_OAUTH_CLIENT_SECRET
 *
 * 完了すると:
 *   1. GBP_REFRESH_TOKEN が表示される → Keychain に保存
 *   2. gbpAccountId / gbpLocationId の確認方法を案内
 *   3. Worker Secret への登録コマンドを表示
 */

const { GBP_OAUTH_CLIENT_ID, GBP_OAUTH_CLIENT_SECRET } = process.env;

if (!GBP_OAUTH_CLIENT_ID || !GBP_OAUTH_CLIENT_SECRET) {
  console.error([
    '',
    '❌ GBP_OAUTH_CLIENT_ID または GBP_OAUTH_CLIENT_SECRET が見つかりません。',
    '',
    '  Keychain に保存するコマンド:',
    "  security add-generic-password -a \"$USER\" -s GBP_OAUTH_CLIENT_ID -w 'YOUR_CLIENT_ID' -U",
    "  security add-generic-password -a \"$USER\" -s GBP_OAUTH_CLIENT_SECRET -w 'YOUR_SECRET' -U",
    '',
    '  Google Cloud Console で OAuth 2.0 クライアントを作成:',
    '  https://console.cloud.google.com/apis/credentials',
    '  アプリケーションの種類: デスクトップアプリ',
    '  リダイレクト URI: urn:ietf:wg:oauth:2.0:oob または http://localhost',
    '',
  ].join('\n'));
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// ── Step 1: 認証 URL を生成してブラウザで開くよう指示 ─────────────────────────

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', GBP_OAUTH_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // refresh_token を必ず発行させる

console.log('\n📋 GBP OAuth セットアップ\n');
console.log('Step 1: 以下の URL をブラウザで開き、Google ビジネス プロフィールの管理者アカウントでログイン');
console.log('        「このアプリはテストモードです」と表示された場合は「続行」をクリック\n');
console.log(authUrl.toString());
console.log('');

// ── Step 2: 認証コードの入力を待つ ──────────────────────────────────────────

import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, output: process.stdout });

const code = await new Promise(resolve => {
  rl.question('Step 2: ブラウザに表示された認証コードを貼り付けてください: ', answer => {
    rl.close();
    resolve(answer.trim());
  });
});

if (!code) {
  console.error('❌ 認証コードが入力されていません。');
  process.exit(1);
}

// ── Step 3: 認証コード → トークン交換 ────────────────────────────────────────

console.log('\n🔄 トークンを取得中...');
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: GBP_OAUTH_CLIENT_ID,
    client_secret: GBP_OAUTH_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
});
const tokenData = await tokenRes.json();

if (!tokenRes.ok || !tokenData.refresh_token) {
  console.error('❌ トークン取得失敗:', JSON.stringify(tokenData, null, 2));
  process.exit(1);
}

const refreshToken = tokenData.refresh_token;
console.log('\n✅ refresh_token を取得しました！\n');

// ── Step 4: アカウント/ロケーション ID を取得 ─────────────────────────────────

console.log('🔍 GBP アカウント一覧を取得中...');
const accountsRes = await fetch('https://mybusiness.googleapis.com/v4/accounts', {
  headers: { Authorization: `Bearer ${tokenData.access_token}` },
});
const accountsData = await accountsRes.json();

if (!accountsRes.ok) {
  console.error('❌ アカウント取得失敗:', JSON.stringify(accountsData, null, 2));
  console.log('\n以下を手動で確認してください:');
  console.log('https://business.google.com/dashboard');
} else {
  const accounts = accountsData.accounts ?? [];
  if (!accounts.length) {
    console.log('⚠️  GBP アカウントが見つかりませんでした。');
    console.log('   このアカウントに Google ビジネス プロフィールが紐付いているか確認してください。');
  } else {
    console.log(`✅ ${accounts.length} 件のアカウントが見つかりました:\n`);
    for (const acc of accounts) {
      console.log(`  gbpAccountId: "${acc.name}"  (${acc.accountName ?? acc.name})`);

      // ロケーション一覧を取得
      const locsRes = await fetch(`https://mybusiness.googleapis.com/v4/${acc.name}/locations?pageSize=20`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const locsData = await locsRes.json();
      const locations = locsData.locations ?? [];

      for (const loc of locations) {
        console.log(`    gbpLocationId: "${loc.name}"  (${loc.locationName ?? loc.title ?? loc.name})`);
      }
      console.log('');
    }
  }
}

// ── Step 5: 次のステップを表示 ───────────────────────────────────────────────

console.log('─────────────────────────────────────────────────────────────────');
console.log('次のステップ:');
console.log('');
console.log('1. Keychain に refresh_token を保存（以下のコマンドをターミナルで実行）:');
console.log(`   security add-generic-password -a "$USER" -s GBP_REFRESH_TOKEN -w '${refreshToken}' -U`);
console.log('');
console.log('2. ~/.config/ai-keys/load.sh に追記:');
console.log('   GBP_REFRESH_TOKEN \\');
console.log('');
console.log('3. Worker Secret に登録（Claude に依頼 or 以下のコマンド）:');
console.log('   source ~/.config/ai-keys/load.sh');
console.log('   echo "$GBP_OAUTH_CLIENT_ID" | npx wrangler@4 secret put GBP_OAUTH_CLIENT_ID');
console.log('   echo "$GBP_OAUTH_CLIENT_SECRET" | npx wrangler@4 secret put GBP_OAUTH_CLIENT_SECRET');
console.log('');
console.log('4. 店舗に GBP 設定を登録（Claude に依頼）:');
console.log('   gbpRefreshToken: <上記 refresh_token>');
console.log('   gbpAccountId:    <上記で確認した accounts/xxx>');
console.log('   gbpLocationId:   <上記で確認した locations/xxx>');
console.log('');
console.log('5. LINE Developer Console で Webhook URL を設定:');
console.log('   https://developers.line.biz/console/');
console.log('   Webhook URL: https://meo-harness.yosinn1.workers.dev/webhook/line-bot');
console.log('   LINE_CHANNEL_SECRET を取得して Keychain に保存:');
console.log("   security add-generic-password -a \"$USER\" -s LINE_CHANNEL_SECRET -w 'YOUR_SECRET' -U");
console.log('');
