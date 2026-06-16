// Worker の POST /review をローカルで通し試験する。
// wrangler dev 起動 + setup-store.mjs 実行後に使う。
//
// 使い方: node scripts/try-worker.mjs

const BASE_URL = process.env.WORKER_URL ?? 'http://localhost:8787';

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json().catch(() => res.text());
  return { status: res.status, data };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => res.text());
  return { status: res.status, data };
}

// ── /health ──────────────────────────────────────────────────────────────────
console.log('--- GET /health ---');
const health = await get('/health');
console.log(`← ${health.status}`, JSON.stringify(health.data, null, 2));

// ── /review ──────────────────────────────────────────────────────────────────
console.log('\n--- POST /review ---');
const review = await post(
  '/review',
  {
    storeId: 'yoshiki-test',
    reviews: [
      { star: 5, text: 'スタッフがとても親切で、雰囲気も最高でした！', name: '田中花子' },
      { star: 3, text: 'サービスは普通でした。もう少し改善できると思います。' },
    ],
  },
  { 'X-API-Key': 'test-key-local' }
);
console.log(`← ${review.status}`, JSON.stringify(review.data, null, 2));

// ── 認証エラー確認 ────────────────────────────────────────────────────────────
console.log('\n--- POST /review (wrong key) ---');
const bad = await post(
  '/review',
  { storeId: 'yoshiki-test', reviews: [{ star: 5, text: 'test' }] },
  { 'X-API-Key': 'wrong-key' }
);
console.log(`← ${bad.status}`, JSON.stringify(bad.data, null, 2));
