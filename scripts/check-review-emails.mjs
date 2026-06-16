// GBPの新着クチコミ通知メールをGmail経由でチェックする（暫定版・手動実行）。
// 実例メールがまだ無いため、現状は検出結果を表示するだけ（Workerへの自動送信はしない）。
// 実例が来たらここでフォーマットを確認し、パーサーを追加してから try-worker.mjs 的に
// POST /review へつなぐ。
//
// 使い方:
//   source ~/.config/ai-keys/load.sh && node scripts/check-review-emails.mjs

import { fetchReviewNotificationEmails } from "../src/gmail-reviews.mjs";

const { GBP_OAUTH_CLIENT_ID, GBP_OAUTH_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;

if (!GBP_OAUTH_CLIENT_ID || !GBP_OAUTH_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
  console.error("❌  環境変数が不足: source ~/.config/ai-keys/load.sh を先に実行してください");
  process.exit(1);
}

const emails = await fetchReviewNotificationEmails({
  clientId: GBP_OAUTH_CLIENT_ID,
  clientSecret: GBP_OAUTH_CLIENT_SECRET,
  refreshToken: GMAIL_REFRESH_TOKEN,
});

console.log(`${emails.length} 件のメールが見つかりました\n`);

for (const m of emails) {
  console.log("─".repeat(60));
  console.log(`From:    ${m.from}`);
  console.log(`Subject: ${m.subject}`);
  console.log(`Date:    ${m.date}`);
  console.log(`Snippet: ${m.snippet}`);
  console.log(`--- text body (先頭500字) ---`);
  console.log((m.text || "(text/plainなし)").slice(0, 500));
}

if (emails.length === 0) {
  console.log("該当メールなし。GBPで新着クチコミがまだ無いか、検索クエリの調整が必要かもしれません。");
}
