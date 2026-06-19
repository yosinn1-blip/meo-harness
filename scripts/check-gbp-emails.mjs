#!/usr/bin/env node
/**
 * check-gbp-emails.mjs — Gmail の GBP クチコミ通知メールを確認するデバッグツール
 *
 * 使い方:
 *   source ~/.config/ai-keys/load.sh && node scripts/check-gbp-emails.mjs
 */

import { getAccessToken, searchMessages, getMessage } from '../src/gmail-reviews.mjs';

const { GBP_OAUTH_CLIENT_ID: clientId, GBP_OAUTH_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: refreshToken } = process.env;

if (!clientId || !clientSecret || !refreshToken) {
  console.error('❌ 環境変数が不足しています。source ~/.config/ai-keys/load.sh を実行してから再試行してください。');
  process.exit(1);
}

console.log('\n📧 GBP クチコミ通知メールを検索中...\n');

const { accessToken } = await getAccessToken({ clientId, clientSecret, refreshToken });

// 広めのクエリで検索（実例メールの形式を確認するため）
const queries = [
  'from:businessprofile-noreply@google.com',
  'from:google-my-business-noreply@google.com',
  'subject:クチコミ',
  'subject:review from:google.com',
  'subject:レビュー from:google.com',
];

for (const query of queries) {
  const messages = await searchMessages({ accessToken, query, maxResults: 3 });
  if (!messages.length) continue;

  console.log(`✅ "${query}" で ${messages.length} 件見つかりました\n`);

  for (const m of messages.slice(0, 2)) {
    const msg = await getMessage({ accessToken, id: m.id });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`件名: ${msg.subject}`);
    console.log(`差出人: ${msg.from}`);
    console.log(`日付: ${msg.date}`);
    console.log(`スニペット: ${msg.snippet}`);
    console.log('\n--- 本文（最初の 800 文字）---');
    const body = (msg.text || msg.html.replace(/<[^>]+>/g, ' ')).slice(0, 800).trim();
    console.log(body);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
  break; // 最初にヒットしたクエリだけ表示
}

console.log('\n（メールが見つからない場合は、まだ GBP からクチコミ通知が来ていない可能性があります）');
