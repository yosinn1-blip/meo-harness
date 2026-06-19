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
 * やること:
 *   1. ブラウザで Google 認証ページを開く
 *   2. 許可すると自動でコードを取得（localhost:4100 でキャッチ）
 *   3. refresh_token と accountId/locationId を表示
 *   4. Keychain / Worker Secret への保存コマンドを表示
 *
 * Google Cloud Console での事前確認（1回だけ）:
 *   https://console.cloud.google.com/apis/credentials
 *   → OAuth クライアントID → 承認済みリダイレクト URI に以下を追加:
 *   http://localhost:4100/callback
 */

import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const { GBP_OAUTH_CLIENT_ID, GBP_OAUTH_CLIENT_SECRET } = process.env;

if (!GBP_OAUTH_CLIENT_ID || !GBP_OAUTH_CLIENT_SECRET) {
  console.error([
    '',
    '❌ GBP_OAUTH_CLIENT_ID または GBP_OAUTH_CLIENT_SECRET が見つかりません。',
    '   source ~/.config/ai-keys/load.sh を実行してから再試行してください。',
    '',
  ].join('\n'));
  process.exit(1);
}

const PORT = 4100;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

// ── Step 1: 認証 URL を組み立ててブラウザで開く ───────────────────────────────

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', GBP_OAUTH_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n📋 GBP OAuth セットアップ\n');
console.log('ブラウザで Google 認証ページを開きます...');
console.log('（自動で開かない場合は以下の URL をブラウザに貼り付けてください）');
console.log('');
console.log(authUrl.toString());
console.log('');

// macOS でデフォルトブラウザを開く
exec(`open "${authUrl.toString()}"`);

// ── Step 2: localhost でコールバックを待ち受ける ──────────────────────────────

console.log(`⏳ Google の認証が完了するのを待っています... (localhost:${PORT})\n`);

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>❌ 認証エラー: ${error}</h2><p>このタブを閉じてください。</p>`);
      server.close();
      reject(new Error(`OAuth エラー: ${error}`));
      return;
    }

    const authCode = url.searchParams.get('code');
    if (!authCode) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>❌ コードが見つかりません</h2><p>このタブを閉じて再試行してください。</p>');
      server.close();
      reject(new Error('code パラメータが見つかりません'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ 認証完了！</h2><p>このタブを閉じてターミナルに戻ってください。</p>');
    server.close();
    resolve(authCode);
  });

  server.listen(PORT, () => {});
  server.on('error', reject);

  // 5分でタイムアウト
  setTimeout(() => {
    server.close();
    reject(new Error('タイムアウト（5分以内に認証が完了しませんでした）'));
  }, 5 * 60 * 1000);
});

// ── Step 3: 認証コード → トークン交換 ────────────────────────────────────────

console.log('🔄 トークンを取得中...');
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
  console.error('\n❌ トークン取得失敗:', JSON.stringify(tokenData, null, 2));
  console.error('\n💡 Google Cloud Console でリダイレクト URI が登録されているか確認してください:');
  console.error(`   ${REDIRECT_URI}`);
  process.exit(1);
}

const refreshToken = tokenData.refresh_token;
console.log('\n✅ 認証成功！\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔑 refresh_token（以下を Keychain に保存してください）:');
console.log('');
console.log(refreshToken);
console.log('');
console.log('  保存コマンド:');
console.log(`  security add-generic-password -a "$USER" -s GBP_REFRESH_TOKEN -w '${refreshToken}' -U`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// ── Step 4: アカウント/ロケーション ID を取得 ─────────────────────────────────

console.log('🔍 GBP アカウントとロケーションを取得中...');
const accountsRes = await fetch('https://mybusiness.googleapis.com/v4/accounts', {
  headers: { Authorization: `Bearer ${tokenData.access_token}` },
});

let accountsData;
try {
  accountsData = await accountsRes.json();
} catch {
  const text = await accountsRes.text().catch(() => '');
  console.log('⚠️  アカウント取得で予期しないレスポンス（API 未有効化の可能性）');
  console.log('   Google Cloud Console で API を有効化:');
  console.log('   https://console.cloud.google.com/apis/library/mybusiness.googleapis.com');
  accountsData = {};
}

let gbpAccountId = '';
let gbpLocationId = '';

if (!accountsRes.ok) {
  console.log('⚠️  アカウント取得失敗（API 承認待ちの可能性あり）:', accountsData.error?.message ?? JSON.stringify(accountsData));
  console.log('   後ほど Google Business Profile API の有効化を確認してください:');
  console.log('   https://console.cloud.google.com/apis/library/mybusiness.googleapis.com');
} else {
  const accounts = accountsData.accounts ?? [];
  if (!accounts.length) {
    console.log('⚠️  このアカウントに紐付く GBP アカウントが見つかりませんでした。');
  } else {
    console.log(`\n📍 見つかったアカウントとロケーション:\n`);
    for (const acc of accounts) {
      console.log(`  アカウント: ${acc.name}  (${acc.accountName ?? ''})`);
      gbpAccountId = gbpAccountId || acc.name;

      const locsRes = await fetch(
        `https://mybusiness.googleapis.com/v4/${acc.name}/locations?pageSize=20`,
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );
      const locsData = await locsRes.json();
      const locations = locsData.locations ?? [];

      for (const loc of locations) {
        const locName = loc.locationName ?? loc.title ?? loc.name;
        console.log(`    ロケーション: ${loc.name}  (${locName})`);
        gbpLocationId = gbpLocationId || loc.name;
      }
      console.log('');
    }
  }
}

// ── Step 5: 次のステップを表示 ───────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log('次のステップ（以下をターミナルで実行してください）:');
console.log('');
console.log('【1】refresh_token を Keychain に保存:');
console.log(`  security add-generic-password -a "$USER" -s GBP_REFRESH_TOKEN -w '${refreshToken}' -U`);
console.log('');
console.log('【2】Claude に以下を伝えて Worker と店舗に設定してもらう:');
console.log('');
console.log(`  GBP_REFRESH_TOKEN を Worker Secret に登録して、`);
console.log(`  yoshiki-apps 店舗に以下を追加してください:`);
console.log(`    gbpRefreshToken: <Keychain の GBP_REFRESH_TOKEN>`);
if (gbpAccountId) console.log(`    gbpAccountId:    "${gbpAccountId}"`);
if (gbpLocationId) console.log(`    gbpLocationId:   "${gbpLocationId}"`);
console.log('');
console.log('【3】LINE Webhook 設定（別途）:');
console.log('  LINE Developer Console → Webhook URL に登録:');
console.log('  https://meo-harness.yosinn1.workers.dev/webhook/line-bot');
console.log('═══════════════════════════════════════════════════════════════');
