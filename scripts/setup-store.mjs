// ローカル KV に店舗設定を登録するセットアップスクリプト。
// wrangler dev を起動した状態で実行する（admin API 経由で KV に書き込む）。
//
// 使い方:
//   source ~/.config/ai-keys/load.sh && node scripts/setup-store.mjs

const BASE_URL = process.env.WORKER_URL ?? 'http://localhost:8787';
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key';
const { LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID } = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
  console.error('❌  環境変数が不足: source ~/.config/ai-keys/load.sh を先に実行してください');
  process.exit(1);
}

const storeId = 'yoshiki-test';
const payload = {
  lineChannelToken: LINE_CHANNEL_ACCESS_TOKEN,
  lineUserId: LINE_USER_ID,
  businessName: 'MEO Harness テスト',
  businessType: 'IT・コンピュータ',
  apiKey: 'test-key-local',
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
