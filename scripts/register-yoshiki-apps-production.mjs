// 本番Workerに「Yoshiki Apps」自身の店舗をadmin API経由で登録する（メール監視の検証用）。
// 使い方:
//   source ~/.config/ai-keys/load.sh && node scripts/register-yoshiki-apps-production.mjs

import { randomBytes } from 'node:crypto';

const BASE_URL = 'https://meo-harness.yosinn1.workers.dev';
const { MEO_HARNESS_ADMIN_KEY: ADMIN_KEY, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID } = process.env;

if (!ADMIN_KEY || !LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
  console.error('❌  環境変数が不足: source ~/.config/ai-keys/load.sh を先に実行してください');
  process.exit(1);
}

const storeId = 'yoshiki-apps';
const apiKey = randomBytes(24).toString('base64url');
const payload = {
  lineChannelToken: LINE_CHANNEL_ACCESS_TOKEN,
  lineUserId: LINE_USER_ID,
  businessName: 'Yoshiki Apps',
  businessType: 'IT・コンピュータ',
  apiKey,
};

console.log(`→ PUT ${BASE_URL}/admin/stores/${storeId}`);
const res = await fetch(`${BASE_URL}/admin/stores/${storeId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
  body: JSON.stringify(payload),
});
const data = await res.json();
if (!res.ok) {
  console.error('❌  失敗:', data);
  process.exit(1);
}
console.log('✅  Store registered:', data);
console.log(`storeId: ${storeId}`);
console.log(`apiKey:  ${apiKey}`);
