# MEO Harness Global Expansion Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** デプロイ・日次ダイジェスト（Cron Trigger）・レビュープラットフォーム Adapter（Yelp/Trustpilot）の3機能を追加する

**Architecture:** `src/cron.mjs`（純関数ヘルパー）・`src/review-parser.mjs`（正規化）・`src/hmac.mjs`（署名検証）の3モジュールを追加し、Worker に `scheduled()` ハンドラとウェブフックエンドポイントを追加する。`processReviews()` を共有関数として抽出することで `/review`・ウェブフック・Cron の3経路が同じパイプラインを通る。

**Tech Stack:** Cloudflare Workers (cron trigger)、Node.js v25 (`--test`)、HMAC-SHA256 (`crypto.subtle`)

## Global Constraints

- テストは `node --test test/*.test.mjs` で全件グリーンを保つ
- 純 fetch のみ（Node / Workers 両動作）
- プロダクションコードを先に書かない（TDD）
- コミットは各タスク完了時

---

## File Map

| 操作 | パス | 役割 |
|---|---|---|
| 作成 | `src/cron.mjs` | mergePendingReviews・shouldSendDigest |
| 作成 | `src/review-parser.mjs` | normalize(platform, raw) |
| 作成 | `src/hmac.mjs` | verifyHmac(secret, body, hexSig) |
| 作成 | `test/cron.test.mjs` | cron ヘルパーのユニットテスト |
| 作成 | `test/review-parser.test.mjs` | review-parser のユニットテスト |
| 作成 | `test/hmac.test.mjs` | HMAC 検証のユニットテスト |
| 変更 | `worker/index.mjs` | processReviews 抽出・daily-digest 分岐・scheduled()・webhook エンドポイント |
| 変更 | `wrangler.toml` | `[triggers]` cron 追加 |

---

## Task 1: 本番デプロイ

**Files:**
- 変更なし（Phase 1 の変更を本番に反映するだけ）

- [ ] **Step 1: git push**

```bash
cd ~/dev/meo-harness
git push origin main
```

Expected: `Everything up-to-date` または `main -> main` が表示される

- [ ] **Step 2: wrangler deploy**

```bash
wrangler deploy
```

Expected: `✨ Success! Deployed meo-harness to ... https://meo-harness.yosinn1.workers.dev`

- [ ] **Step 3: ヘルスチェック**

```bash
curl -s https://meo-harness.yosinn1.workers.dev/health | python3 -m json.tool
```

Expected:
```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

---

## Task 2: `src/cron.mjs` — 純関数ヘルパー

**Files:**
- Create: `src/cron.mjs`
- Create: `test/cron.test.mjs`

**Interfaces:**
- Produces:
  - `mergePendingReviews(existing: Array, incoming: Array) → Array`
  - `shouldSendDigest(store: { notifyMode?: string }) → boolean`

- [ ] **Step 1: 失敗するテストを書く**

`test/cron.test.mjs` を新規作成：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePendingReviews, shouldSendDigest } from '../src/cron.mjs';

test('mergePendingReviews: 既存バッファに新しいレビューを追加する', () => {
  const existing = [{ star: 5, text: 'よかった' }];
  const incoming = [{ star: 3, text: '普通' }];
  const result = mergePendingReviews(existing, incoming);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], existing[0]);
  assert.deepEqual(result[1], incoming[0]);
});

test('mergePendingReviews: 既存バッファが空でも動く', () => {
  const result = mergePendingReviews([], [{ star: 4, text: 'good' }]);
  assert.equal(result.length, 1);
});

test('mergePendingReviews: null/undefined を空配列として扱う', () => {
  assert.equal(mergePendingReviews(null, [{ star: 1, text: 'x' }]).length, 1);
  assert.equal(mergePendingReviews([{ star: 1, text: 'x' }], null).length, 1);
});

test('shouldSendDigest: notifyMode=daily-digest → true', () => {
  assert.equal(shouldSendDigest({ notifyMode: 'daily-digest' }), true);
});

test('shouldSendDigest: notifyMode=immediate → false', () => {
  assert.equal(shouldSendDigest({ notifyMode: 'immediate' }), false);
});

test('shouldSendDigest: notifyMode 未設定 → false', () => {
  assert.equal(shouldSendDigest({}), false);
  assert.equal(shouldSendDigest(null), false);
});
```

- [ ] **Step 2: テストが RED になることを確認**

```bash
node --test test/cron.test.mjs 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND` または `SyntaxError` で fail

- [ ] **Step 3: `src/cron.mjs` を実装**

```js
/**
 * 既存のバッファ配列に新しいレビューを追加する。
 * @param {Array|null} existing
 * @param {Array|null} incoming
 * @returns {Array}
 */
export function mergePendingReviews(existing, incoming) {
  return [...(existing ?? []), ...(incoming ?? [])];
}

/**
 * 店舗が daily-digest モードかどうか返す。
 * @param {{ notifyMode?: string }|null} store
 * @returns {boolean}
 */
export function shouldSendDigest(store) {
  return store?.notifyMode === 'daily-digest';
}
```

- [ ] **Step 4: テストが GREEN になることを確認**

```bash
node --test test/cron.test.mjs 2>&1 | tail -5
```

Expected: `pass 6` / `fail 0`

- [ ] **Step 5: 全テストが引き続きグリーンであることを確認**

```bash
node --test test/*.test.mjs 2>&1 | tail -5
```

Expected: `fail 0`

- [ ] **Step 6: コミット**

```bash
git add src/cron.mjs test/cron.test.mjs
git commit -m "feat: add cron helper functions (mergePendingReviews, shouldSendDigest)"
```

---

## Task 3: Worker — daily-digest バッファリング + Cron Trigger

**Files:**
- Modify: `worker/index.mjs`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes:
  - `mergePendingReviews` from `../src/cron.mjs`
  - `shouldSendDigest` from `../src/cron.mjs`
  - `generateReply`, `PROVIDERS` from `../src/reply-engine.mjs`（既存）
  - `sendDigest` from `../src/notify.mjs`（既存）

このタスクは Worker の挙動変更のため、ユニットテストではなく `wrangler dev` + curl でローカル検証する。

- [ ] **Step 1: `wrangler.toml` に cron を追加**

`wrangler.toml` の末尾に追記：

```toml
# ── Cron Trigger: 日次ダイジェスト（00:00 UTC = 09:00 JST）───────────────────
[triggers]
crons = ["0 0 * * *"]
```

- [ ] **Step 2: `worker/index.mjs` の import に cron ヘルパーを追加**

先頭の import 群に追加（既存の import の直後）：

```js
import { mergePendingReviews, shouldSendDigest } from '../src/cron.mjs';
```

- [ ] **Step 3: `processReviews` を共有関数として抽出**

`handleReview` の内部ロジック（AI下書き生成 + 通知）を `processReviews` として抽出する。
`worker/index.mjs` の `handleReview` 関数の後（`handleSignup` の前）に追加：

```js
// ── 共通パイプライン: AI下書き生成 → バッファ or 即時通知 ────────────────────────

async function processReviews(reviews, store, storeId, env) {
  const { businessName, businessType } = store;

  // AI 下書き生成（並列・best-effort）
  const settled = await Promise.allSettled(
    reviews.map(review =>
      generateReply({
        review,
        business: { type: businessType ?? '店舗', name: businessName ?? storeId },
        provider: PROVIDERS.GROQ,
        providerConfig: { apiKey: env.GROQ_API_KEY },
      }).then(r => ({ ...review, draft: r.text, warnings: r.warnings, tokens: r.tokens }))
    )
  );

  const processed = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { ...reviews[i], draft: null, draftError: r.reason?.message }
  );
  const failed = processed.filter(r => r.draft == null).length;

  // daily-digest モード: KV バッファに蓄積して即通知しない
  if (shouldSendDigest(store)) {
    const existingRaw = await env.STORES.get(`pending:${storeId}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const merged = mergePendingReviews(existing, processed);
    await env.STORES.put(`pending:${storeId}`, JSON.stringify(merged));
    return { buffered: true, count: merged.length };
  }

  // immediate モード（既定）: 即時通知
  const notifyResult = await sendDigest({ store, reviews: processed });
  return { buffered: false, processed: processed.length, failed, notify: notifyResult };
}
```

- [ ] **Step 4: `handleReview` を `processReviews` を使うように書き換え**

`handleReview` の AI生成・通知部分を `processReviews` 呼び出しに置き換える。

既存の `handleReview` 内の「AI 下書き生成（並列・best-effort）」から末尾の `return json(...)` までを以下に差し替え：

```js
  let result;
  try {
    result = await processReviews(reviews, store, storeId, env);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }

  if (result.buffered) {
    return json({ ok: true, buffered: result.count, source: reviewSource ?? 'unknown' });
  }
  return json({ ok: true, ...result, source: reviewSource ?? 'unknown' });
```

- [ ] **Step 5: `scheduled()` ハンドラを追加**

`export default { async fetch(...) {...} }` を以下に差し替え（`scheduled` を追加）：

```js
export default {
  async fetch(request, env) {
    // 既存の fetch ハンドラの中身はそのまま
    ...
  },

  async scheduled(controller, env, ctx) {
    const list = await env.STORES.list({ prefix: 'pending:' });
    if (!list.keys.length) return;

    const results = await Promise.allSettled(
      list.keys.map(({ name: key }) => handlePendingStore(key, env))
    );

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[cron] failed for ${list.keys[i].name}:`, r.reason?.message);
      }
    });
  },
};

async function handlePendingStore(pendingKey, env) {
  const storeId = pendingKey.slice('pending:'.length);

  const [storeRaw, pendingRaw] = await Promise.all([
    env.STORES.get(`store:${storeId}`),
    env.STORES.get(pendingKey),
  ]);

  // 孤児キー（店舗設定が消えた）は削除して終了
  if (!storeRaw) {
    await env.STORES.delete(pendingKey);
    return;
  }

  const store = JSON.parse(storeRaw);
  const reviews = pendingRaw ? JSON.parse(pendingRaw) : [];
  if (!reviews.length) {
    await env.STORES.delete(pendingKey);
    return;
  }

  // AI下書き生成（並列・best-effort）
  const settled = await Promise.allSettled(
    reviews.map(review =>
      generateReply({
        review,
        business: { type: store.businessType ?? '店舗', name: store.businessName ?? storeId },
        provider: PROVIDERS.GROQ,
        providerConfig: { apiKey: env.GROQ_API_KEY },
      }).then(r => ({ ...review, draft: r.text, warnings: r.warnings }))
    )
  );

  const processed = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...reviews[i], draft: null }
  );

  // 通知送信 — 成功時のみバッファ削除、失敗時は次回 Cron で再試行
  await sendDigest({ store, reviews: processed });
  await env.STORES.delete(pendingKey);
}
```

- [ ] **Step 6: ローカルで動作確認**

```bash
# ターミナル1: Worker 起動
wrangler dev

# ターミナル2: daily-digest モードの店舗を登録
source ~/.config/ai-keys/load.sh
node -e "
const res = await fetch('http://localhost:8787/admin/stores/test-digest', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.MEO_HARNESS_ADMIN_KEY },
  body: JSON.stringify({
    apiKey: 'test-api-key',
    businessName: 'テスト店舗',
    businessType: 'ヘアサロン',
    notificationChannel: 'line',
    lineChannelToken: 'dummy',
    lineUserId: 'dummy',
    notifyMode: 'daily-digest',
  }),
});
console.log(await res.json());
"
```

Expected: `{ ok: true, storeId: 'test-digest' }`

```bash
# レビューを POST → バッファに蓄積されること
node -e "
const res = await fetch('http://localhost:8787/review', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
  body: JSON.stringify({ storeId: 'test-digest', reviews: [{ star: 5, text: 'よかった' }] }),
});
console.log(await res.json());
"
```

Expected: `{ ok: true, buffered: 1, source: 'unknown' }`（通知は送信されない）

```bash
# Cron を手動トリガー
curl -s "http://localhost:8787/__scheduled?cron=0+0+*+*+*"
```

Expected: 200 レスポンス（バッファが処理される）

- [ ] **Step 7: 全テストが引き続きグリーンであることを確認**

```bash
node --test test/*.test.mjs 2>&1 | tail -5
```

Expected: `fail 0`

- [ ] **Step 8: コミット**

```bash
git add src/cron.mjs worker/index.mjs wrangler.toml
git commit -m "feat: daily-digest buffer mode + Cron Trigger scheduled handler"
```

---

## Task 4: `src/review-parser.mjs` — プラットフォーム正規化

**Files:**
- Create: `src/review-parser.mjs`
- Create: `test/review-parser.test.mjs`

**Interfaces:**
- Produces:
  - `normalize(platform: 'gbp'|'yelp'|'trustpilot', rawReview: object) → { star: number, text: string, name?: string, platform: string, platformId?: string }`

- [ ] **Step 1: 失敗するテストを書く**

`test/review-parser.test.mjs` を新規作成：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/review-parser.mjs';

// ── GBP ──────────────────────────────────────────────────────────────────────

test('normalize gbp: フィールドをそのまま通す', () => {
  const r = normalize('gbp', { star: 5, text: '最高でした', name: '田中', platformId: 'gbp-001' });
  assert.equal(r.star, 5);
  assert.equal(r.text, '最高でした');
  assert.equal(r.name, '田中');
  assert.equal(r.platform, 'gbp');
  assert.equal(r.platformId, 'gbp-001');
});

test('normalize gbp: name が無い場合は省略', () => {
  const r = normalize('gbp', { star: 3, text: '普通' });
  assert.equal('name' in r, false);
});

// ── Yelp ──────────────────────────────────────────────────────────────────────

test('normalize yelp: rating→star, user.name→name, id→platformId', () => {
  const r = normalize('yelp', {
    rating: 4,
    text: 'Great food!',
    user: { name: 'John D.' },
    id: 'yelp-abc-123',
  });
  assert.equal(r.star, 4);
  assert.equal(r.text, 'Great food!');
  assert.equal(r.name, 'John D.');
  assert.equal(r.platform, 'yelp');
  assert.equal(r.platformId, 'yelp-abc-123');
});

test('normalize yelp: user が無い場合は name を省略', () => {
  const r = normalize('yelp', { rating: 3, text: 'ok' });
  assert.equal('name' in r, false);
});

test('normalize yelp: star を 0〜5 にクランプする', () => {
  assert.equal(normalize('yelp', { rating: 7, text: 'x' }).star, 5);
  assert.equal(normalize('yelp', { rating: -1, text: 'x' }).star, 0);
});

// ── Trustpilot ────────────────────────────────────────────────────────────────

test('normalize trustpilot: stars→star, consumer.displayName→name', () => {
  const r = normalize('trustpilot', {
    stars: 5,
    text: 'Excellent service',
    consumer: { displayName: 'Alice' },
    id: 'tp-xyz',
  });
  assert.equal(r.star, 5);
  assert.equal(r.text, 'Excellent service');
  assert.equal(r.name, 'Alice');
  assert.equal(r.platform, 'trustpilot');
  assert.equal(r.platformId, 'tp-xyz');
});

test('normalize trustpilot: consumer が無い場合は name を省略', () => {
  const r = normalize('trustpilot', { stars: 4, text: 'good' });
  assert.equal('name' in r, false);
});

test('normalize trustpilot: star を 0〜5 にクランプする', () => {
  assert.equal(normalize('trustpilot', { stars: 10, text: 'x' }).star, 5);
});

// ── 共通 ──────────────────────────────────────────────────────────────────────

test('normalize: 未知のプラットフォームは例外を投げる', () => {
  assert.throws(
    () => normalize('google-maps', { star: 5, text: 'x' }),
    /Unknown review platform: google-maps/,
  );
});
```

- [ ] **Step 2: テストが RED になることを確認**

```bash
node --test test/review-parser.test.mjs 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND` で fail

- [ ] **Step 3: `src/review-parser.mjs` を実装**

```js
// MEO Harness — レビュープラットフォーム正規化
//
// 各プラットフォームのレビューデータを内部形式 { star, text, name?, platform, platformId? } に変換する。
// 内部形式は generateReply / sendDigest が受け付ける形式と同一。

function clampStar(n) {
  const parsed = parseInt(n, 10);
  if (isNaN(parsed)) return 0;
  return Math.max(0, Math.min(5, parsed));
}

const ADAPTERS = {
  gbp(raw) {
    return {
      star: clampStar(raw.star),
      text: raw.text ?? '',
      ...(raw.name ? { name: raw.name } : {}),
      platform: 'gbp',
      ...(raw.platformId ? { platformId: String(raw.platformId) } : {}),
    };
  },
  yelp(raw) {
    return {
      star: clampStar(raw.rating),
      text: raw.text ?? '',
      ...(raw.user?.name ? { name: raw.user.name } : {}),
      platform: 'yelp',
      ...(raw.id != null ? { platformId: String(raw.id) } : {}),
    };
  },
  trustpilot(raw) {
    return {
      star: clampStar(raw.stars),
      text: raw.text ?? '',
      ...(raw.consumer?.displayName ? { name: raw.consumer.displayName } : {}),
      platform: 'trustpilot',
      ...(raw.id != null ? { platformId: String(raw.id) } : {}),
    };
  },
};

/**
 * プラットフォーム固有のレビューデータを内部フォーマットに正規化する。
 * @param {'gbp'|'yelp'|'trustpilot'} platform
 * @param {object} rawReview
 * @returns {{ star: number, text: string, name?: string, platform: string, platformId?: string }}
 */
export function normalize(platform, rawReview) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`Unknown review platform: ${platform}`);
  return adapter(rawReview);
}
```

- [ ] **Step 4: テストが GREEN になることを確認**

```bash
node --test test/review-parser.test.mjs 2>&1 | tail -5
```

Expected: `pass 9` / `fail 0`

- [ ] **Step 5: 全テストが引き続きグリーンであることを確認**

```bash
node --test test/*.test.mjs 2>&1 | tail -5
```

Expected: `fail 0`

- [ ] **Step 6: コミット**

```bash
git add src/review-parser.mjs test/review-parser.test.mjs
git commit -m "feat: add review platform adapter (GBP/Yelp/Trustpilot normalizer)"
```

---

## Task 5: `src/hmac.mjs` + Webhook エンドポイント

**Files:**
- Create: `src/hmac.mjs`
- Create: `test/hmac.test.mjs`
- Modify: `worker/index.mjs`

**Interfaces:**
- Consumes:
  - `normalize` from `../src/review-parser.mjs`
  - `verifyHmac` from `../src/hmac.mjs`
  - `processReviews` (Task 3 で追加した共有関数)
- Produces:
  - `POST /webhook/yelp` — Yelp レビュー Webhook
  - `POST /webhook/trustpilot` — Trustpilot レビュー Webhook

- [ ] **Step 1: HMAC テストを書く**

`test/hmac.test.mjs` を新規作成：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHmac } from '../src/hmac.mjs';

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

test('verifyHmac: 正しい署名を受け入れる', async () => {
  const secret = 'my-webhook-secret';
  const body = '{"text":"hello"}';
  const sig = sign(secret, body);
  assert.equal(await verifyHmac(secret, body, sig), true);
});

test('verifyHmac: 改ざんされたボディは拒否する', async () => {
  const secret = 'my-webhook-secret';
  const sig = sign(secret, '{"text":"hello"}');
  assert.equal(await verifyHmac(secret, '{"text":"tampered"}', sig), false);
});

test('verifyHmac: 誤った秘密鍵は拒否する', async () => {
  const body = '{"text":"hello"}';
  const sig = sign('correct-secret', body);
  assert.equal(await verifyHmac('wrong-secret', body, sig), false);
});

test('verifyHmac: secret または signature が空の場合は false', async () => {
  assert.equal(await verifyHmac('', 'body', 'abc123'), false);
  assert.equal(await verifyHmac('secret', 'body', ''), false);
});

test('verifyHmac: 不正な hex 文字列は false を返す（例外を投げない）', async () => {
  assert.equal(await verifyHmac('secret', 'body', 'not-hex!!'), false);
});
```

- [ ] **Step 2: HMAC テストが RED になることを確認**

```bash
node --test test/hmac.test.mjs 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND` で fail

- [ ] **Step 3: `src/hmac.mjs` を実装**

```js
// MEO Harness — HMAC-SHA256 Webhook 署名検証
//
// Webhook の発信元を確認するため、共有シークレットで署名した hex digest と
// リクエストボディを照合する。crypto.subtle を使うため Node / Workers 両対応。

/**
 * @param {string} secret   店舗 KV に保存した webhookSecret
 * @param {string} rawBody  リクエストのテキストボディ（そのまま）
 * @param {string} hexSig   X-Webhook-Secret ヘッダの hex 文字列
 * @returns {Promise<boolean>}
 */
export async function verifyHmac(secret, rawBody, hexSig) {
  if (!secret || !hexSig) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sigBytes = Uint8Array.from(
      hexSig.match(/.{2}/g).map(h => parseInt(h, 16)),
    );
    const bodyBytes = new TextEncoder().encode(rawBody);
    return crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: HMAC テストが GREEN になることを確認**

```bash
node --test test/hmac.test.mjs 2>&1 | tail -5
```

Expected: `pass 5` / `fail 0`

- [ ] **Step 5: Worker に webhook エンドポイントを追加**

`worker/index.mjs` の import 群に追加：

```js
import { normalize } from '../src/review-parser.mjs';
import { verifyHmac } from '../src/hmac.mjs';
```

`fetch` ハンドラのルーティングに追加（`return jsonError('Not Found', 404)` の直前）：

```js
      if (path.startsWith('/webhook/')) {
        const platform = path.slice('/webhook/'.length);
        if (method === 'POST') return await handleWebhook(request, env, platform);
      }
```

`handleAdminPut` の後に `handleWebhook` 関数を追加：

```js
// ── /webhook/:platform ────────────────────────────────────────────────────────

async function handleWebhook(request, env, platform) {
  const storeId = request.headers.get('X-Store-Id') ?? '';
  if (!storeId) return jsonError('X-Store-Id header is required', 400);

  const storeRaw = await env.STORES.get(`store:${storeId}`);
  if (!storeRaw) return jsonError(`Unknown store: ${storeId}`, 404);
  const store = JSON.parse(storeRaw);

  // HMAC 署名検証（webhookSecret が未設定の店舗は拒否）
  if (!store.webhookSecret) return jsonError('Webhook not configured for this store', 403);
  const signature = request.headers.get('X-Webhook-Secret') ?? '';
  const rawBody = await request.text();
  const valid = await verifyHmac(store.webhookSecret, rawBody, signature);
  if (!valid) return jsonError('Invalid webhook signature', 401);

  let rawReview;
  try { rawReview = JSON.parse(rawBody); } catch { return jsonError('Invalid JSON body', 400); }

  // プラットフォーム固有フォーマット → 内部フォーマット
  let review;
  try {
    review = normalize(platform, rawReview);
  } catch (err) {
    return jsonError(err.message, 400);
  }

  // 共通パイプライン（AI下書き生成 → バッファ or 即時通知）
  let result;
  try {
    result = await processReviews([review], store, storeId, env);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }

  if (result.buffered) {
    return json({ ok: true, buffered: result.count, platform });
  }
  return json({ ok: true, ...result, platform });
}
```

- [ ] **Step 6: `handleAdminPut` で `webhookSecret` を受け取るように更新**

`handleAdminPut` 内の `const { ... } = body ?? {};` の行を以下に変更：

```js
  const {
    lineChannelToken, lineUserId,
    telegramBotToken, telegramChatId,
    businessName, businessType, apiKey,
    notificationChannel, timezone, notifyMode,
    webhookSecret,
  } = body ?? {};
```

`store` オブジェクトの構築に `notifyMode` と `webhookSecret` を追加：

```js
  const store = {
    apiKey, businessName, businessType, notificationChannel: channel,
    ...(timezone ? { timezone } : {}),
    ...(notifyMode ? { notifyMode } : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(lineChannelToken ? { lineChannelToken } : {}),
    ...(lineUserId ? { lineUserId } : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
  };
```

- [ ] **Step 7: 全テストが GREEN であることを確認**

```bash
node --test test/*.test.mjs 2>&1 | tail -8
```

Expected: `fail 0`（tests 70+ / pass 全件）

- [ ] **Step 8: ローカルで webhook エンドポイントを確認**

```bash
# wrangler dev が起動していること前提

# 正しい署名でテスト（webhookSecret を設定した店舗を先に登録すること）
source ~/.config/ai-keys/load.sh
SECRET="test-webhook-secret-1234"
BODY='{"rating":5,"text":"Great service!","user":{"name":"John"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -s -X POST http://localhost:8787/webhook/yelp \
  -H "Content-Type: application/json" \
  -H "X-Store-Id: <storeId>" \
  -H "X-Webhook-Secret: $SIG" \
  -d "$BODY" | python3 -m json.tool
```

Expected: `{ "ok": true, "platform": "yelp", ... }`

- [ ] **Step 9: コミット**

```bash
git add src/hmac.mjs src/review-parser.mjs test/hmac.test.mjs worker/index.mjs
git commit -m "feat: webhook endpoints for Yelp/Trustpilot with HMAC validation"
```

---

## Task 6: 本番デプロイ（Phase 2 完了）

- [ ] **Step 1: 全テスト最終確認**

```bash
node --test test/*.test.mjs 2>&1 | grep -E 'pass|fail'
```

Expected: `fail 0`

- [ ] **Step 2: git push**

```bash
git push origin main
```

- [ ] **Step 3: wrangler deploy**

```bash
wrangler deploy
```

- [ ] **Step 4: 本番 health チェック**

```bash
curl -s https://meo-harness.yosinn1.workers.dev/health
```

Expected: `{ "status": "ok" }`

- [ ] **Step 5: 不正署名で 401 が返ることを確認**

```bash
curl -s -X POST https://meo-harness.yosinn1.workers.dev/webhook/yelp \
  -H "Content-Type: application/json" \
  -H "X-Store-Id: dummy" \
  -H "X-Webhook-Secret: invalidsig" \
  -d '{"rating":5,"text":"test"}' | python3 -m json.tool
```

Expected: `{ "error": "Unknown store: dummy" }` (404) — ストアが存在しないため署名検証の前に弾かれる

---

## 自己レビューチェック

- [x] Task 1 から Task 6 で spec の全要件をカバー
- [x] `processReviews` は Task 3 で定義し Task 5 で参照（一貫したシグネチャ）
- [x] `normalize` は Task 4 で定義し Task 5 で参照
- [x] `verifyHmac` は Task 5 の Step 3 で定義し Step 5 で参照
- [x] `mergePendingReviews` / `shouldSendDigest` は Task 2 で定義し Task 3 で参照
- [x] TDD: 全タスクでテストを先に書く
- [x] 「TBD」「TODO」なし
- [x] タイムゾーン処理なし（JST 固定・スコープ外と明記済み）
