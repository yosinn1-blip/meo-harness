# MEO Harness Self-Service Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 記事読者が管理者との個別連絡なしで Google 店舗と LINE を接続でき、人にも AI にも読める導入案内を提供する。

**Architecture:** 同一 Worker 上に一般利用者用の画面・API・認証を追加する。新規店舗の本人認証・権限・状態・予算予約は D1 を正本とし、既存の KV 店舗は移行せず互換アダプタで維持する。新規登録は既定 OFF のままローカル実装と外部通信をスタブ化した E2E を完成させ、本番公開は別の承認付き gate とする。

**Tech Stack:** 既存 ESM JavaScript、Cloudflare Workers/D1/KV、Web Crypto、`jose@6.2.12`、`node:test`、`miniflare@4.20260730.0`、`@playwright/test@1.63.0`。Node の確認済み実行環境は `22.23.1`。ブラウザは Chrome for Testing 専用プロファイル。

**Spec:** `/Users/yoshiki/dev/meo-harness/docs/superpowers/specs/2026-09-27-self-service-onboarding-design.md`（2026-09-27 に本人承認。基準 commit `43d2a0d`）。

**Status:** 実装計画レビュー待ち。以下のコードは実装時の契約・テスト例であり、実装済みではない。

## Global Constraints

- 「美容院での試用は並行して進め、導線の実装開始を試用終了まで待たせない。」
- 「初期対象は 1 Google 利用者につき 1 店舗・1 LINE 通知先。」
- 「初期セッションは 24 時間、再ログインで回復。state は 10 分。」
- 「LINE の新コードは読み間違えにくい 12 文字のランダム値、15 分、有効な発行は店舗あたり 1 件。」
- 「確認番号は 5 分・最大 5 回・単回消費で、再発行時に旧番号を失効。」
- 「自己登録は `daily-digest` を既定にする。初回は直近 60 日の未返信から 5 件まで。」
- 「接続テストの再送は 1 店舗 1 分 1 回・1 日 3 回まで。」
- 「公開受付は feature flag で既定 OFF。」数値未設定は 0 として拒否する。
- 「未完了登録の資格情報は最終操作から 24 時間で削除。」
- 「承認待ちの本文は 7 日で失効、利用者操作の監査記録は 30 日で削除。」
- 「既存の管理者登録店舗は KV のまま維持し、一括移行しない。」
- 「本物の口コミへの投稿は、対象と本文の本人確認後だけ行い、Google 上の反映まで確認する。」
- 案内サイト `/Users/yoshiki/dev/yoshiki-apps` の未コミット変更を上書き・stash・commit しない。
- 既存 `npm test` の Node テスト 160 件を削除・skip して成功扱いにしない。
- `.dev.vars`、Keychain、実トークン、実店舗本文をローカルテストや委譲プロンプトに読ませない。

## Review Focus

1. **別タブ・別端末・期限境界:** 古い callback、再ログイン、再発行前コードが他の登録を上書きしない（Task 3/4/6）。
2. **登録後に Google の権限や口コミが変わる:** 古い返信を別店舗に投稿せず、店主が直接書いた返信を上書きしない（Task 5/9）。
3. **HTTP 成功後に DB 更新が失敗する:** AI・LINE・Google の再試行で重複消費・重複送信を増やさない（Task 7/8/9）。
4. **共有 LINE を別サービスも消費する:** 台帳だけを信用せず実 quota を見て保留し、未処理を捨てない（Task 7/8）。
5. **日本語・長文・スマホ・口コミゼロ:** 省略された返信本文を知らずに承認させず、接続成功と投稿成功を区別する（Task 9/10/11）。

---

## 実行方針と境界

実行は Codex 本体で依存順に進め、節目で差分とテストを確認する。進め方の選択を本人に再度求めない。
2026-09-27 の安全リスト読取では `meo-harness` に `allow_zai` の対象登録がなかった。安全リストを自動拡張しない。
実装開始時に再確認し、対象なら GLM を隔離先で 1 回だけ試す。対象外なら「安全リスト外」を記録して Codex で続行する。
同じ checkout を外部エージェントと並行編集しない。429 等の再試行・権限迂回をしない。

この計画は 1 本の自己登録フロー。認証だけの公開や、UI だけの公開はしない。
各 Task の commit は検証単位であり、途中段階での deploy を意味しない。
実装時は `list_artifacts` →適切な既存 worktree の確認→必要なら管理ツールで新規隔離 worktree、の順にする。
以下の相対パスは、その隔離 worktree の root を基準にする。元 repo は `/Users/yoshiki/dev/meo-harness`。

### フラグの意味

| 設定 | 既定 | 効果 |
|---|---|---|
| `SELF_REGISTRATION_ENABLED` | `false` | 新規 Google 業務接続・新規店舗追加を許可するか |
| `SELF_PROCESSING_ENABLED` | `false` | 新規 D1 店舗の取得・生成・通知・公開投稿を許可するか |
| `SELF_DB` | 未接続 | 無ければ新規経路を閉じる。旧 KV 経路は維持 |
| `SELF_PUBLIC_ORIGIN` | 未設定 | 許可 Origin と callback URL の唯一の根拠。Host ヘッダから推定しない |
| `SELF_MAX_ACTIVE_STORES` | `0` | 自己登録 active 店舗数上限 |
| `SELF_MONTHLY_DRAFT_LIMIT` | `0` | 1 店舗の月間生成数 |
| `SELF_MONTHLY_PUSH_LIMIT` | `0` | 本機能が使える共有チャネル月間 push 数 |
| `SELF_LEGACY_PUSH_RESERVE` | 未設定=受付不可 | 他サービス用確保数。0 も明示設定を要求 |
| `SELF_TERMS_VERSION` | 未設定=開始不可 | 利用開始時に合意した説明の版 |

Secrets: `SELF_TOKEN_KEY_V1`（32-byte AES key）、`SELF_RATE_KEY`（IP 仮名化用）、`TURNSTILE_SECRET_KEY`。
既存 Google/LINE/Groq Secrets は名前だけ再利用する。値をファイルへコピーしない。
`TURNSTILE_SITE_KEY` と `SELF_LINE_FRIEND_URL` は公開設定として別管理。
新規受付を止めても、既存利用者のログイン・状態確認・停止・切断は利用可能にする。

## ファイル責任表

| 範囲 | ファイル | 責任 |
|---|---|---|
| 契約 | `worker/self-service/{contracts,config,errors}.mjs` | 定数、状態、制限値、公開エラー |
| 保存 | `migrations/0001_self_service.sql`、`worker/self-service/store-repository.mjs` | schema、利用者/店舗、location 一意予約 |
| 認証 | `worker/self-service/{crypto,session,oauth,abuse}.mjs` | 暗号、Cookie、OIDC、CSRF、Turnstile |
| 接続 | `worker/self-service/{google,locations,line-link}.mjs` | 店舗の権限確認、LINE 二段階確認 |
| 実行制御 | `worker/self-service/{budget,lifecycle,retention}.mjs` | 予約、稼働停止、保存期間 |
| 口コミ | `worker/self-service/{jobs,ingestion,notifications,approvals}.mjs` | 取得→生成→通知→承認投稿 |
| HTTP | `worker/self-service/{router,status,views}.mjs` | 一般 API とエラー変換、安全な UI 配信 |
| UI | `worker/self-service/ui/{start,account}.html`、`{app.js.txt,style.css}` | 初回登録と管理画面。JSはtextとしてbundle |
| 統合 | `worker/index.mjs`、`src/gbp.mjs`、`src/line-flex.mjs` | 最小限の既存経路接続、互換 API |
| 検証 | `test/self-*.test.mjs`、`test/self-runtime/*.test.mjs`、`test/support/self-*.mjs`、`test/e2e/` | 単体、実 D1、スタブ E2E |
| 実行補助 | `scripts/{build-self-test,serve-self-test,check-self-release}.mjs` | 本番と分離した build/preview/release check |
| 案内 | `docs/{quickstart,ai-setup,self-hosting,self-service-release}.md` | 人/AI/自前運用/公開 gate |

## 共通契約

以下は `worker/self-service/contracts.mjs` の JSDoc と export にまとめる。型の二重定義を作らない。

```js
export const LIMITS = Object.freeze({
  sessionMs: 86400000, oauthMs: 600000, linkMs: 900000,
  pinMs: 300000, pinAttempts: 5, firstPollDays: 60,
  batchReviews: 5, requestBytes: 16384, webhookBytes: 262144,
  googlePageSize: 50, googlePagesPerRun: 2,
  processingConcurrency: 2, testCooldownMs: 60000, testsPerDay: 3,
});
// Ctx = {db, env, now:()=>number, fetchImpl:(RequestInfo,RequestInit?)=>Promise<Response>}
// Actor = {sub:string, sessionHash:string, csrf:string}
// Store = {id:string, ownerSub:string, accountId:string, locationId:string,
//          title:string, state:string, generation:number, lineUserId:string|null}
// Result = {ok:true, code:string} | {ok:false, code:string}
export const SELF_LINE_PREFIX = 'MEOS-';
export const SELF_REPLY_PREFIX = 'ss_';
export const SELF_COOKIE = '__Host-meo_session';
```

`SelfError(code,status)` は内部の provider 応答本文を受け取らない。
公開 JSON は `{ok:false, code, message, requestId}`、成功は `{ok:true,...}`。
時刻は DB では UTC epoch milliseconds、月キーは通知 quota に合わせ Asia/Tokyo の `YYYY-MM`、日キーも同 timezone。
通知時刻の初期値は JST 9 時。対象国による新たな登録制限は追加せず、timezone 選択 UI は今回追加しない。
暗号の context は credential=`google:${sub}`、口コミ=`job:${jobId}`、返信=`reply:${replyId}`、通知=`notification:${notificationId}` に固定する。
`SELF_TOKEN_KEY_V1` は32-byte値のbase64。テストは架空鍵だけを使う。

### HTTP 契約

| Method/path | 入力 | 出力/処理 |
|---|---|---|
| GET `/api/self/status` | Cookie | 匿名を含む状態、CSRF、設定済み公開制限、次の操作 |
| POST `/api/self/google/start` | `intent:connect/login/reconnect`, Turnstile | `authorizationUrl` |
| GET `/api/self/google/callback` | Google code/state | 検証後 `/account` へ 303、秘密クエリを落とす |
| GET `/api/self/locations` | Cookie, opaque `cursor` | 本人が管理可能な候補のみ |
| POST `/api/self/location` | `accountId,locationId` | 店舗確定 |
| POST `/api/self/line/code` | 空 JSON | `code,expiresAt,addFriendUrl` |
| POST `/api/self/line/test` | 空 JSON | 明示テスト送信、番号そのものは返さない |
| POST `/api/self/line/verify` | `pin` | 通知先を確認済みに |
| POST `/api/self/activate` | `termsVersion,confirmed:true` | 再権限確認→枠予約→active。pausedからの再開も同じAPIで枠再利用 |
| POST `/api/self/pause` | `confirmed:true` | future work 停止 |
| POST `/api/self/disconnect` | `confirmed:true` | token/本文を切断・削除、既存 Google 返信は残す |
| POST `/api/self/logout` | 空 JSON | session 失効 |
| GET `/api/self/replies/:id` | Cookie | 本人の期限内口コミ・返信全文のみ。他owner/失効は404 |

`/account/replies/:id` は本人ログイン後に上記 read-only API を使う全文確認画面。URLにtokenを含めず、承認操作はLINEで維持する。

全 POST は Origin/CSRF 必須。callback と LINE Webhook はそれぞれ state/署名で検証し、通常 CSRF の例外をパス固定にする。

---

### Task 1: 外部通信しないローカル harness と契約

**Files:** Create `worker/self-service/{contracts,config,errors}.mjs`, `test/support/self-runtime.mjs`, `test/self-config.test.mjs`; Modify `package.json`, `.gitignore`; Create `package-lock.json` if absent.

**Interfaces:** `config.mjs` が `readSelfConfig(env) -> {registrationEnabled,processingEnabled,configured,limits}`、`createSelfContext(env,{now=Date.now,fetchImpl=fetch}={}) -> Ctx` をexport。test helperが `withD1(t) -> Promise<{db,mf}>` と `fixtureEnv(db,overrides={}) -> env` をexport。D1 helper は毎回空 DB を作り、`t.after` で dispose。

- [x] **Step 1: 次の失敗テストを書く。**

```js
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSelfConfig} from '../worker/self-service/config.mjs';
test('設定省略は無制限でなく閉じる', () => {
  const c = readSelfConfig({SELF_REGISTRATION_ENABLED:'true'});
  assert.equal(c.configured, false);
  assert.equal(c.registrationEnabled, false);
  assert.equal(c.limits.maxActiveStores, 0);
});
```

- [x] **Step 2: `node --test test/self-config.test.mjs` で未実装による FAIL を記録。**
- [x] **Step 3: config は非負整数のみ受理し、負数・NaN・空値を拒否。flag は文字列 `true` だけを true とする。**

```js
function nonNegativeInteger(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value ?? ''))) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}
```

`npm install --save-exact jose@6.2.12`、`npm install -D --save-exact miniflare@4.20260730.0 @playwright/test@1.63.0 esbuild@0.28.2` を隔離先で実行。package/lock にexact versionを固定。
Vitest への移行はしない。既存 `npm test` は維持し、`test:self-runtime` を `node --test --test-concurrency=1 test/self-runtime/*.test.mjs` として追加。

```js
import {Miniflare} from 'miniflare';
export async function withD1(t) {
  const mf = new Miniflare({
    modules:true, compatibilityDate:'2024-11-01',
    script:'export default {fetch(){return new Response("test-only")}}',
    d1Databases:['SELF_DB'], kvNamespaces:['STORES'],
    outboundService: () => { throw new Error('UNEXPECTED_EXTERNAL_IO'); },
  });
  t.after(() => mf.dispose());
  return {db:await mf.getD1Database('SELF_DB'),mf};
}
export function fixtureEnv(db,overrides={}) {
  return {SELF_DB:db,SELF_PUBLIC_ORIGIN:'https://meo.test',
    SELF_REGISTRATION_ENABLED:'true',SELF_PROCESSING_ENABLED:'true',
    SELF_MAX_ACTIVE_STORES:'1',SELF_MONTHLY_DRAFT_LIMIT:'1',
    SELF_MONTHLY_PUSH_LIMIT:'3',SELF_LEGACY_PUSH_RESERVE:'0',
    SELF_TERMS_VERSION:'fixture-v1',
    SELF_TOKEN_KEY_V1:Buffer.alloc(32,7).toString('base64'),
    SELF_RATE_KEY:'fixture-rate',TURNSTILE_SECRET_KEY:'fixture-turnstile',
    TURNSTILE_SITE_KEY:'fixture-site',SELF_LINE_FRIEND_URL:'https://meo.test/line',
    GBP_OAUTH_CLIENT_ID:'fixture-client',GBP_OAUTH_CLIENT_SECRET:'fixture-client-secret',
    LINE_CHANNEL_ACCESS_TOKEN:'fixture-line',LINE_CHANNEL_SECRET:'fixture-line-secret',
    GROQ_API_KEY:'fixture-groq',...overrides};
}
```

`fixtureEnv` は test 配下だけで利用し、本番コードからimportしない。configの受付可否と処理可否を分け、受付OFFや店舗枠満了が既存店舗の停止画面を無効にしない。

- [x] **Step 4: config の flag/整数境界テスト、D1 `SELECT 1`、既存 `npm test` を実行。** `.dev.vars` を helper が読まないことをコードで確認。
- [x] **Step 5: この Task のファイルのみ commit。** `git commit -m "test: add isolated self-service runtime harness"`

### Task 2: D1 スキーマと店舗の一意予約

**Files:** Create `migrations/0001_self_service.sql`, `worker/self-service/store-repository.mjs`, `test/self-runtime/store-repository.test.mjs`; Extend `test/support/self-runtime.mjs`。

**Interfaces:** Produces `applySchema(db)` と `seedStore(ctx,{sub,state,lineUserId}) -> Store`（test helper）、`claimLocation(ctx,{sub,accountId,locationId,title}) -> Store`、`findOwnedStore(ctx,sub) -> Store|null`、`reserveLegacyLocations(ctx,rows) -> {count}`。`rows` は `{storeId,locationId}` だけ、token を含めない。

- [x] **Step 1: 同時登録を実 D1 で試す。**

```js
test('同じ location は別 owner から同時登録できない', async t => {
  const {db} = await withD1(t); await applySchema(db);
  const ctx = createSelfContext({SELF_DB:db});
  const results = await Promise.allSettled(['alice','bob'].map(sub =>
    claimLocation(ctx,{sub,accountId:'accounts/1',locationId:'locations/2',title:'架空店'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM location_claims').first()).n,1);
});
```

- [x] **Step 2: `node --test test/self-runtime/store-repository.test.mjs` → FAIL。**
- [x] **Step 3: SQL を用意し、最小 repository を実装。**

```sql
PRAGMA foreign_keys = ON;
CREATE TABLE users (sub TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE stores (
 id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL UNIQUE REFERENCES users(sub),
 account_id TEXT NOT NULL, location_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
 line_user_id TEXT, pending_line_user_id TEXT, terms_version TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE location_claims (
 location_id TEXT PRIMARY KEY, store_id TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL CHECK(mode IN ('legacy','self'))
);
CREATE TABLE google_credentials (
 owner_sub TEXT PRIMARY KEY REFERENCES users(sub), ciphertext TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, owner_sub TEXT, csrf TEXT NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE oauth_attempts (
 state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, intent TEXT NOT NULL,
 verifier_ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE line_links (
 code_hash TEXT PRIMARY KEY, store_id TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE line_checks (
 store_id TEXT PRIMARY KEY, pin_hash TEXT NOT NULL, generation INTEGER NOT NULL,
 session_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
);
CREATE TABLE usage_budgets (
 scope TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL,
 cap INTEGER NOT NULL CHECK(cap>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
 PRIMARY KEY(scope,period,kind)
);
CREATE TABLE usage_reservations (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units>0), state TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE review_jobs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL, review_id TEXT NOT NULL,
 review_version TEXT NOT NULL, generation INTEGER NOT NULL, stage TEXT NOT NULL,
 payload_ciphertext TEXT, lease_id TEXT, lease_until INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(store_id,review_id,review_version)
);
CREATE TABLE replies (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL,
 generation INTEGER NOT NULL, draft_ciphertext TEXT, draft_hash TEXT NOT NULL,
 state TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE notification_jobs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL, generation INTEGER NOT NULL,
 day_key TEXT NOT NULL, part INTEGER NOT NULL, retry_key TEXT NOT NULL UNIQUE,
 payload_ciphertext TEXT, state TEXT NOT NULL, first_attempt_at INTEGER,
 accepted_request_id TEXT, lease_id TEXT, lease_until INTEGER,
 UNIQUE(store_id,day_key,part)
);
CREATE TABLE notification_items (
 notification_id TEXT NOT NULL, reply_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(notification_id,reply_id)
);
CREATE TABLE location_cursors (
 token_hash TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, payload_ciphertext TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, store_id TEXT, actor_hash TEXT, action TEXT NOT NULL,
 result_code TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE poll_cursors (
 store_id TEXT PRIMARY KEY, page_token TEXT, scan_started_at INTEGER,
 latest_completed_at INTEGER
);
CREATE TABLE rate_limits (
 bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON review_jobs(stage,next_attempt_at);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX audit_expiry ON audit_events(created_at);
```

`claimLocation` は user 作成、store 作成、location_claim 作成を `db.batch` でまとめる。先に SELECT して空なら INSERT だけ、という競合する実装にしない。
同じ sub/location の再送は既存値を返す。別 owner と競合した場合は `LOCATION_UNAVAILABLE/409` のみ返す。

テスト用店舗は実repositoryを通して作り、存在しないstoreを理由に処理がskipされるテストにしない。

```js
export async function seedStore(ctx,{sub='alice',state='active',lineUserId='line-a'}={}) {
  const store=await claimLocation(ctx,{sub,accountId:'accounts/1',
    locationId:'locations/2',title:'架空店'});
  await ctx.db.prepare('UPDATE stores SET state=?,line_user_id=? WHERE id=?')
    .bind(state,lineUserId,store.id).run();
  return findOwnedStore(ctx,sub);
}
```

- [x] **Step 4: 同一 owner 再送、別 owner、legacy 予約衝突、片方失敗時 rollback、部分ページ移行をテスト。**
- [x] **Step 5: `git commit -m "feat: add transactional self-service ownership storage"`。**

### Task 3: 暗号・セッション・CSRF・受付保護

**Files:** Create `worker/self-service/{crypto,session,abuse}.mjs`, `test/self-security.test.mjs`, `test/self-runtime/session.test.mjs`。

**Interfaces:** Produces `seal(text,key,context)` / `unseal(envelope,key,context)`、`sha256(text)`、`createSession(ctx,sub|null)`、`requireActor(ctx,request)`、`requireMutation(ctx,request)`、`verifyChallenge(ctx,{token,ip,action})`、`consumeRate(ctx,{bucket,limit,windowMs})`。Session 出力は `{cookie,csrf,sessionHash}`。

- [x] **Step 1: 暗号の用途混同と cookie/CSRF の失敗を固定。**

```js
test('token を別 owner に移して復号できない', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelope = await seal('fixture-refresh',key,'google:alice');
  assert.equal(await unseal(envelope,key,'google:alice'),'fixture-refresh');
  await assert.rejects(()=>unseal(envelope,key,'google:bob'));
});
test('Origin が異なる更新は拒否', async t => {
  const {db}=await withD1(t); await applySchema(db);
  const ctx=createSelfContext({SELF_DB:db,SELF_PUBLIC_ORIGIN:'https://meo.test'});
  const req=new Request('https://meo.test/api/self/pause',{
    method:'POST',headers:{Origin:'https://attacker.test'},body:'{}'});
  await assert.rejects(()=>requireMutation(ctx,req),e=>e.code==='ORIGIN_DENIED');
});
test('24時間ちょうどで旧セッションを拒否',async t=>{
  const {db}=await withD1(t);await applySchema(db);
  let now=Date.parse('2026-09-27T00:00:00Z');
  const ctx=createSelfContext(fixtureEnv(db),{now:()=>now});
  const session=await createSession(ctx,'alice');
  const request=new Request('https://meo.test/api/self/status',{
    headers:{Cookie:session.cookie.split(';')[0]}});
  assert.equal((await requireActor(ctx,request)).sub,'alice');
  now+=LIMITS.sessionMs;
  await assert.rejects(()=>requireActor(ctx,request),e=>e.code==='LOGIN_REQUIRED');
});
```

- [x] **Step 2: 対象 Node/runtime テストを実行し、未実装 FAIL を確認。**
- [x] **Step 3: Web Crypto AES-GCM、256-bit key、96-bit fresh IV、AAD に context と key version。**

```js
const aad = new TextEncoder().encode(`v1:${context}`);
const ciphertext = await crypto.subtle.encrypt(
  {name:'AES-GCM',iv,additionalData:aad}, cryptoKey,
  new TextEncoder().encode(text));
```

セッション secret は 32-byte random、DB は SHA-256。Cookie は host-only/HttpOnly/Secure/SameSite=Lax/Path=/。
匿名 session を `GET status` で作り CSRF を返す。認証後は新 ID に回転し、旧 session と紐づく未完了試行を失効。
JSON body は streaming 読取で 16 KiB 超を拒否し、Content-Length を信用しない。
Turnstile は Siteverify の `success`、正しい hostname、action=`self_start` を必須にする。失敗本文をログに出さない。
IP は毎日変える HMAC の bucket だけ保存。start は IP 10回/10分、LINEコード発行は owner 5回/10分、各 API は owner 60回/分。
rate increment は `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE used < ? RETURNING used`、expiry の更新も同一 statement で行う。

- [x] **Step 4: 同時制限、未設定 Secret、oversized chunked body、24h境界、期限切れCookie、CSRFなし、偽Turnstile hostname/action をテスト。**
- [x] **Step 5: `git commit -m "feat: protect self-service sessions and mutations"`。**

### Task 4: Google OIDC と再ログイン

**Files:** Create `worker/self-service/{oauth,google}.mjs`, `test/self-oauth.test.mjs`, `test/self-runtime/oauth.test.mjs`, `test/support/self-google.mjs`。

**Interfaces:** Produces `startGoogle(ctx,request,{intent,challenge}) -> {authorizationUrl}`、`finishGoogle(ctx,request) -> Response`、`verifyGoogleIdToken(token,{jwks,clientId,nonce,now}) -> {sub}`、`googleAccessToken(ctx,sub) -> string`。
`self-google.mjs` は fixture 用 RSA keypair/JWKS と署名済 ID token、固定 provider 応答を生成する。私有鍵はメモリ内のみ。`seedGoogleCredential(ctx,sub)` もここからexportする。

- [x] **Step 1: nonce と署名の検証を試す。**

```js
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
test('正しい署名でも別nonceなら拒否', async () => {
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk={...(await exportJWK(publicKey)),kid:'fixture'};
  const token=await new SignJWT({nonce:'other'})
    .setProtectedHeader({alg:'RS256',kid:'fixture'})
    .setIssuer('https://accounts.google.com').setAudience('fixture-client')
    .setSubject('alice').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(()=>verifyGoogleIdToken(token,{
    jwks:{keys:[jwk]},clientId:'fixture-client',nonce:'expected',now:Date.now}),
    e=>e.code==='GOOGLE_IDENTITY_INVALID');
});
```

- [x] **Step 2: `node --test test/self-oauth.test.mjs` → FAIL。**
- [x] **Step 3: 固定の Google discovery/JWKS/token URLs だけへ fetch。JWT 検証は `jose`。**

```js
const {payload}=await jwtVerify(token,createLocalJWKSet(jwks),{
  issuer:['https://accounts.google.com','accounts.google.com'],
  audience:clientId,algorithms:['RS256'],currentDate:new Date(now()),
  requiredClaims:['iss','sub','aud','iat','exp'],clockTolerance:30,
});
if(payload.nonce!==nonce || (payload.azp && payload.azp!==clientId))
  throw new SelfError('GOOGLE_IDENTITY_INVALID',401);
```

PKCE verifier は暗号化保存、challenge は SHA-256/base64url。state は hash 保存。
callback は Cookie の sessionHash と一致する state のみ `DELETE ... WHERE state_hash=? AND session_hash=? AND expires_at>? RETURNING *` で消費する。
ログイン intent に store/token 更新を許さない。reconnect では現 session の sub と同じ Google sub を要求。
初回 connect は `openid business.manage`・offline。login は `openid` のみ。refresh token が再接続で省略された場合は、同一 sub の有効な既存 credential を維持し、存在しなければ再認可を案内する。
Google エラー query/code はログ・HTML に出さず、安全な code だけ保存し 303 `/account` に戻す。

```js
export async function seedGoogleCredential(ctx,sub) {
  const key=Uint8Array.from(Buffer.from(ctx.env.SELF_TOKEN_KEY_V1,'base64'));
  const ciphertext=await seal('fixture-refresh',key,`google:${sub}`);
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO users(sub,created_at) VALUES (?,?) ON CONFLICT DO NOTHING')
      .bind(sub,ctx.now()),
    ctx.db.prepare('INSERT INTO google_credentials(owner_sub,ciphertext,updated_at) VALUES (?,?,?)')
      .bind(sub,ciphertext,ctx.now()),
  ]);
}
```

- [x] **Step 4: 改ざん署名、issuer/aud/exp/azp、別ブラウザstate、state再送、拒否callback、loginがcredentialを消さない、別人reconnect拒否を実行。**
- [x] **Step 5: `git commit -m "feat: add Google self-service sign-in and reconnect"`。**

### Task 5: Google 店舗選択と秘密を返さない status API

**Files:** Create `worker/self-service/{locations,status,router}.mjs`, `test/self-runtime/locations.test.mjs`; Modify `src/gbp.mjs`, `test/gbp.test.mjs`。

**Interfaces:** Produces `discoverLocations(ctx,actor,{cursor=null}={}) -> {locations,nextCursor,partial}`、`selectLocation(ctx,actor,{accountId,locationId}) -> Store`、`getSelfStatus(ctx,request) -> object`、`handleSelfRequest(request,env,ctx) -> Response|null`。
GBP に `listGbpAccountsPage({accessToken,pageToken,fetchImpl})` / `listGbpLocationsPage({accessToken,accountId,pageToken,fetchImpl})` / `fetchGbpReviewsPage({accessToken,accountId,locationId,pageToken,pageSize,fetchImpl})` を追加。戻り値は `{items,nextPageToken}`、既存配列返却関数は互換維持。

- [x] **Step 1: 一覧になかった店舗 ID の注入を拒否。**

```js
test('一覧に存在しない店舗は確定しない', async t => {
  const {db}=await withD1(t); await applySchema(db);
  const ctx=createSelfContext(fixtureEnv(db),{fetchImpl:async input=>{
    const url=new URL(input instanceof Request?input.url:input);
    if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
    if(url.pathname==='/v1/accounts')return Response.json({accounts:[{name:'accounts/1'}]});
    if(url.pathname==='/v1/accounts/1/locations')
      return Response.json({locations:[{name:'locations/2',title:'架空店'}]});
    if(url.pathname==='/v1/locations/999')return Response.json({}, {status:404});
    throw new Error('UNEXPECTED_PROVIDER_CALL');
  }});
  await seedGoogleCredential(ctx,'alice');
  await assert.rejects(()=>selectLocation(ctx,{sub:'alice'},
    {accountId:'accounts/1',locationId:'locations/999'}),
    e=>e.code==='LOCATION_NOT_ACCESSIBLE');
});
```

対照テストでは同じfixtureの `locations/2` を選ぶと成功することを確認する。認証失敗で常に拒否するだけの実装を通さない。

- [x] **Step 2: 対象 runtime テスト → FAIL。**
- [x] **Step 3: ページングの契約を追加し、選択時は provider で再確認してから claim。**

```js
export async function fetchGbpReviewsPage({accessToken,accountId,locationId,pageToken,
  pageSize=50,fetchImpl=fetch}) {
  const url=new URL(`https://mybusiness.googleapis.com/v4/${accountId}/${locationId}/reviews`);
  url.searchParams.set('pageSize',String(pageSize));
  url.searchParams.set('orderBy','updateTime desc');
  if(pageToken)url.searchParams.set('pageToken',pageToken);
  const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!response.ok)throw Object.assign(new Error('GBP_API_UNAVAILABLE'),{status:response.status});
  const data=await response.json();
  return {items:data.reviews??[],nextPageToken:data.nextPageToken??null};
}
```

新しいページング関数は self-service adapter で provider エラーを分類する。legacy が既存エラーメッセージに依存するテストは壊さない。
1 店舗でも確定ボタンを必要とする。title/IDs は再取得した値で保存し、入力の店舗名を信用しない。
候補が多い場合はページ継続ボタン。cursorはhashを `location_cursors` に保存し、owner-boundなページ情報を暗号化して10分で失効。外部URLは保存/利用しない。
status は明示した whitelist のみ組み立てる。credential、token、lineUserId、他人の owner、SQL row 全体を spread しない。

- [x] **Step 4: 0/1/複数・第2ページ・一部403・API500・owner差し替え・status秘密非表示・既存GBPテストを実行。**
- [x] **Step 5: `git commit -m "feat: add owned Google location selection"`。**

### Task 6: LINE 登録、確認番号、既存承認の本人照合

**Files:** Create `worker/self-service/line-link.mjs`, `test/self-runtime/line-link.test.mjs`, `test/self-line-webhook.test.mjs`; Modify `worker/index.mjs:377-509`。

**Interfaces:** Produces `issueLineCode(ctx,actor)`、`consumeLineCode(ctx,event)`、`sendLineCheck(ctx,actor)`、`verifyLinePin(ctx,actor,pin)`、`authorizeLineActor({source,registeredUserId,active}) -> boolean`。
LINE API transport は `fetchImpl` を受ける。新 code は `MEOS-` + 12文字、reply IDs は `ss_`。

- [x] **Step 1: 他人の LINE とグループを拒否する。**

```js
test('正しいpostback IDでも他人のLINEは不可',()=>{
  assert.equal(authorizeLineActor({source:{type:'user',userId:'bob'},
    registeredUserId:'alice',active:true}),false);
  assert.equal(authorizeLineActor({source:{type:'group',userId:'alice'},
    registeredUserId:'alice',active:true}),false);
});
```

- [x] **Step 2: unit/runtime を実行して FAIL。**
- [x] **Step 3: link/PIN は hash 保存・原子的消費。**

```sql
UPDATE line_links SET consumed_at=?
 WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?
 RETURNING store_id;
```

コード一致後は `pending_line_user_id` に保存。登録済み通知先は PIN 確認成功まで置き換えない。
テスト通知の6桁PINは CSPRNG で生成し、attempt上限の increment と照合を同一 DB 操作列で保護。
`sendLineCheck` は明示操作・Task 7 の rate/quota を使う。Task 7 ができるまではテスト transport 専用で、本番配線しない。
Webhook は 256 KiB 上限、署名 Secret なし/不一致を 401、JSON 不正400。署名照合は既存 HMAC helper を再利用する。
legacy の approve/skip は reply を読む→store を読む→userId一致と1対1を確認→操作、の順に変更。未登録や不明な状態は拒否。
既存 store に state がない場合は legacy 稼働扱いとし、削除済み store は拒否。新店舗では state=active のみ許可。

- [x] **Step 4: 同時コード消費1回、再発行失効、期限境界、PIN5回失敗、別ブラウザ/owner、署名なし、skipの本人照合、旧登録コードの回帰を実行。**
- [x] **Step 5: `git commit -m "feat: verify LINE ownership before enabling replies"`。**

### Task 7: 予算予約・稼働開始・停止・切断・保存期間

**Files:** Create `worker/self-service/{budget,lifecycle,retention}.mjs`, `test/self-runtime/{budget,lifecycle}.test.mjs`。

**Interfaces:** Produces `reserveUsage(ctx,{id,scope,period,kind,units}) -> Result`、`reserveUsageBatch(ctx,reservations) -> Result`（同じ引数形の配列を全件原子的に予約）、`settleUsage(ctx,id,outcome)`（outcome=`committed/released/uncertain`）、`activateStore(ctx,actor,{termsVersion,confirmed})`、`pauseStore(ctx,actor)`、`disconnectStore(ctx,actor)`、`purgeExpired(ctx)`。予約の `kind` は `active/draft/push/reply`、active枠だけ `period='lifetime'`。

- [x] **Step 1: 上限最後の1枠への同時アクセスを固定。**

```js
test('残り1枠を二重予約しない', async t=>{
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext({SELF_DB:db});
  await db.prepare('INSERT INTO usage_budgets VALUES (?,?,?,?,?)')
    .bind('channel','2026-09','push',1,0).run();
  const out=await Promise.all(['a','b'].map(id=>reserveUsage(ctx,
    {id,scope:'channel',period:'2026-09',kind:'push',units:1})));
  assert.equal(out.filter(x=>x.ok).length,1);
});
```

- [x] **Step 2: runtime test → FAIL。**
- [x] **Step 3: conditional INSERT + trigger で多重消費を防ぐ。**

```sql
CREATE TRIGGER reservation_within_budget BEFORE INSERT ON usage_reservations
WHEN NOT EXISTS(SELECT 1 FROM usage_reservations r WHERE r.id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM usage_budgets b WHERE b.scope=NEW.scope
 AND b.period=NEW.period AND b.kind=NEW.kind AND b.used+NEW.units<=b.cap)
BEGIN SELECT RAISE(ABORT,'QUOTA_EXHAUSTED'); END;
CREATE TRIGGER reservation_count AFTER INSERT ON usage_reservations
BEGIN UPDATE usage_budgets SET used=used+NEW.units
 WHERE scope=NEW.scope AND period=NEW.period AND kind=NEW.kind; END;
CREATE TRIGGER reservation_same_identity BEFORE INSERT ON usage_reservations
WHEN EXISTS(SELECT 1 FROM usage_reservations r WHERE r.id=NEW.id
 AND (r.scope<>NEW.scope OR r.period<>NEW.period OR r.kind<>NEW.kind OR r.units<>NEW.units))
BEGIN SELECT RAISE(ABORT,'RESERVATION_MISMATCH'); END;
```

```js
test('成功後のDB応答消失を想定した同ID再送は満枠でも二重消費しない',async t=>{
  const {db}=await withD1(t);await applySchema(db);
  const ctx=createSelfContext({SELF_DB:db});
  await db.prepare('INSERT INTO usage_budgets VALUES (?,?,?,?,?)')
    .bind('channel','2026-09','push',1,0).run();
  const input={id:'stable',scope:'channel',period:'2026-09',kind:'push',units:1};
  assert.equal((await reserveUsage(ctx,input)).ok,true);
  assert.equal((await reserveUsage(ctx,input)).ok,true);
  assert.equal((await db.prepare('SELECT used FROM usage_budgets').first()).used,1);
});
```

`INSERT ... ON CONFLICT(id) DO NOTHING` の再送時は既存 reservation と引数が全一致するときだけ同じ結果を返す。BEFORE triggerも既存IDを除外し、満枠後の同一予約の再送を誤って拒否しない。
全scopeの予約を `db.batch` にまとめ、どれか一つでも枠不足なら全体rollback。既存IDとscope/period/kind/unitsが違えば BEFORE triggerで `RESERVATION_MISMATCH` をRAISEし、同じbatchの予約も残さない。
released への遷移だけ減算する trigger を追加し、uncertain は減算しない。同じIDの units やscopeを変えた要求は409。
activate の active枠予約・state更新・terms記録を同一 batch にし、その直前に Google 権限を再確認。
pause は generation を増やし future lease を拒否。disconnect はこの停止を先に確定し token/本文を消す。
active 枠は pause で保持し、disconnect で返す。reconnect/resume は以前の枠を二重予約しない。
共有 LINE の quota と consumption を送信前に確認。残量不明や上限到達なら保留し、こちらの cap と実残量の小さい方に従う。
同じボットを別サービスが使うため、保証できるのは本機能の予算内停止と provider quota の尊重であり、外部サービスの予約制御ではない。
retention は LIMIT 100 のバッチ削除。未完了24h、本文7日、監査30日を固定。本文期限後も重複送信を防ぐ最小の口コミID/version/処理結果を利用中だけ保持し、切断時には消す。通知payloadと期限切れcursorも対象にする。

- [x] **Step 4: 同ID再送、複数scope枠のrollback、月末JST、provider quota不明、停止と予約競合、切断後callback/LINE無効、保持期間を実行。**
- [x] **Step 5: `git commit -m "feat: bound self-service usage and lifecycle"`。**

### Task 8: ページング付き取得・AI 生成・日次通知

**Files:** Create `worker/self-service/{jobs,ingestion,notifications}.mjs`, `test/self-runtime/pipeline.test.mjs`; Extend `worker/self-service/google.mjs`, `src/notify.mjs` の互換オプション。

**Interfaces:** Produces `pollSelfStore(ctx,storeId)`、`processSelfJobs(ctx,{limit:5})`、`sendSelfDigest(ctx,storeId)`、`remainingPushBudget({localRemaining,providerRemaining,legacyReserve}) -> number`、`claimJob(ctx,{id,stage,leaseMs})`、`finishJob(ctx,{id,leaseId,stage})`。
Job stage は `fetched/drafting/draft_ready/notifying/notified/posting/post_unknown/posted/skipped/expired/blocked`、失敗の再試行は元 stage と `next_attempt_at` で管理。

- [x] **Step 1: quota停止で口コミが失われないことを固定。**

```js
test('生成枠0ではjobを残してAIを呼ばない',async t=>{
  const {db}=await withD1(t);await applySchema(db);
  let calls=0;
  const ctx=createSelfContext(fixtureEnv(db,{SELF_MONTHLY_DRAFT_LIMIT:'0'}),
    {fetchImpl:async()=>{calls++;throw new Error('UNEXPECTED_PROVIDER_CALL');}});
  const store=await seedStore(ctx);
  const key=Uint8Array.from(Buffer.from(ctx.env.SELF_TOKEN_KEY_V1,'base64'));
  const payload=await seal(JSON.stringify({reviewId:'r1',text:'架空の口コミ',star:5,
    updateTime:'2026-09-27T00:00:00Z'}),key,'job:j1');
  await db.prepare(`INSERT INTO review_jobs
    (id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at)
    VALUES ('j1',?,'r1','v1',1,'fetched',?,0,?,?)`)
    .bind(store.id,payload,ctx.now(),ctx.now()).run();
  await processSelfJobs(ctx,{limit:5});
  assert.equal(calls,0);
  assert.equal((await db.prepare('SELECT stage FROM review_jobs WHERE id=?').bind('j1').first()).stage,'fetched');
});
```

対照テストは月間生成枠1で同じfixtureを使い、Groqへの1回の要求と `draft_ready` を確認する。fixtureの不備を理由にskipするだけで合格させない。

```js
test('共有ボットの外部消費と残量不明を安全側で扱う',()=>{
  assert.equal(remainingPushBudget({localRemaining:10,providerRemaining:2,legacyReserve:2}),0);
  assert.equal(remainingPushBudget({localRemaining:10,providerRemaining:null,legacyReserve:0}),0);
  assert.equal(remainingPushBudget({localRemaining:10,providerRemaining:5,legacyReserve:2}),3);
});
```

- [x] **Step 2: runtime test → FAIL。**
- [x] **Step 3: ページ単位の job INSERT と cursor 前進を一つの batch にする。**

```sql
UPDATE review_jobs SET stage=?,lease_id=?,lease_until=?,attempts=attempts+1
 WHERE id=? AND stage=? AND (lease_until IS NULL OR lease_until<?)
 RETURNING *;
```

1 runは2ページ・各50件まで。途中pageTokenを保存し次のcronで続行。pageTokenが失効したらscanを再開し UNIQUE(job key)で重複を排除。
初回60日で cutoff、生成対象は5件まで、残りjobは残す。normalize に updateTime を追加し、version は review内容/更新時刻から作る。
生成前に budget を予約、成功したdraftを暗号化保存。失敗は1/5/30分バックオフ、5回連続でblockedとしてUI案内。timeout等の結果不明は生成枠を解放せず記録。
通知は `notification_jobs/items` に対象返信・暗号化済み送信payload・UUIDのretry keyを送信前に保存し、再送でも本文/宛先/キーを変更しない。上限に応じて分割し、payloadへ含めたreplyだけを受理確認後にnotifiedとする。
LINEの初回pushから `X-Line-Retry-Key` を付ける。409は `x-line-accepted-request-id` のある再送応答のみ受理済みとして記録し、200も実到達とは区別する。初回から24時間超の結果不明は自動再送せず保留する。reply APIにはretry headerを付けない。
毎日JST9時、既存cronから呼び出す。遅延実行でも同日のdigestを重複生成しない。

- [x] **Step 4: 51件/複数ページ、境界60日、AI失敗、LINE timeout後retry-key、DB失敗後再開、外部quota消費、生成/通知で停止をそれぞれ実行。**
- [x] **Step 5: `git commit -m "feat: add bounded review processing for self-service stores"`。**

### Task 9: 承認投稿と「結果不明」の回復

**Files:** Create `worker/self-service/approvals.mjs`, `test/self-runtime/approvals.test.mjs`; Modify `src/gbp.mjs`, `src/line-flex.mjs`, それぞれの既存テスト。

**Interfaces:** Produces `handleSelfPostback(ctx,event)`、`reconcileReply(ctx,replyId)`、`classifyCurrentReview({current,approvedDraft,storedReviewVersionTime}) -> posted/conflict/unchanged`、`readOwnedReply(ctx,actor,replyId) -> {reviewText,draftText,expiresAt}`、GBP の `getGbpReview({accessToken,accountId,locationId,reviewId,fetchImpl}) -> raw review`。

- [x] **Step 1: 他人からの approve/skip と、停止後の古いボタンを拒否。**

```js
test('停止中はapproveでもGoogle投稿ゼロ',async t=>{
  const {db}=await withD1(t);await applySchema(db);
  let writes=0;
  const ctx=createSelfContext(fixtureEnv(db),{fetchImpl:async(_,init)=>{
    if(init?.method==='PUT')writes++;
    return Response.json({});
  }});
  const store=await seedStore(ctx,{state:'paused'});
  const key=Uint8Array.from(Buffer.from(ctx.env.SELF_TOKEN_KEY_V1,'base64'));
  const draft=await seal('架空の返信',key,'reply:ss_r1');
  await db.prepare(`INSERT INTO replies
    (id,job_id,store_id,generation,draft_ciphertext,draft_hash,state,expires_at)
    VALUES ('ss_r1','j1',?,1,?,?,'pending',?)`)
    .bind(store.id,draft,await sha256('架空の返信'),ctx.now()+60000).run();
  const result=await handleSelfPostback(ctx,{source:{type:'user',userId:'line-a'},
    postback:{data:'approve:ss_r1'}});
  assert.equal(result.code,'STORE_INACTIVE');assert.equal(writes,0);
});
```

- [x] **Step 2: runtime test → FAIL。**
- [x] **Step 3: 本人→状態/世代→期限→Google現行口コミ→原子的lease→再状態確認→PUT の順に実装。**

```js
const current=await getGbpReview(args);
if(current.reviewReply?.comment===approvedDraft) return markConfirmedPosted();
if(current.reviewReply?.comment) return markConflict('REVIEW_ALREADY_REPLIED');
if(current.updateTime!==storedReviewVersionTime) return markConflict('REVIEW_CHANGED');
```

上の `markConfirmedPosted()` / `markConflict(code)` は `approvals.mjs` 内のクロージャで、reply/jobの状態と本文保持期限をD1に記録する。単体 export は不要。
比較判定は `classifyCurrentReview` に切り出し、実投稿経路から必ず使う。本人が直接書いた返信と口コミ編集のテストを固定する。

```js
test('手動返信と更新済み口コミを上書きしない',()=>{
  assert.equal(classifyCurrentReview({current:{reviewReply:{comment:'店主の返信'},updateTime:'v1'},
    approvedDraft:'AI案',storedReviewVersionTime:'v1'}),'conflict');
  assert.equal(classifyCurrentReview({current:{updateTime:'v2'},
    approvedDraft:'AI案',storedReviewVersionTime:'v1'}),'conflict');
  assert.equal(classifyCurrentReview({current:{updateTime:'v1'},
    approvedDraft:'AI案',storedReviewVersionTime:'v1'}),'unchanged');
});
```
GoogleへのPUTは既存 `postGbpReply` を利用。HTTP失敗と transport結果不明を分類し、後者はpost_unknownにしてGET照合へ。
同じ本文があればposted、別本文があればconflict、返信がない場合は前回本文を保持して本人に再承認を求める。勝手に新本文を作って再投稿しない。
LINEに表示できる本文長を超えるdraftは、ボタンを付けず「全文を確認してください」と表示。勝手に切り詰めた本文を承認対象にしない。
今回の生成上限は返信1200文字とし、長すぎる生成結果はdraftエラーで再生成候補へ。口コミ全文が長すぎる場合は確認画面への自分専用リンクで読む。

- [x] **Step 4: 手動返信との競合、レビュー編集、同時承認、PUT後DB失敗、タイムアウト後同文/異文、skip偽装、長文/絵文字を実行。**
- [x] **Step 5: `git commit -m "feat: reconcile owner-approved Google replies safely"`。**

### Task 10: 同一オリジン画面とルーティング統合

**Files:** Create `worker/self-service/views.mjs`, `worker/self-service/ui/{start,account}.html`, `worker/self-service/ui/{app.js.txt,style.css}`, `scripts/build-self-test.mjs`, `test/self-ui.test.mjs`; Modify `worker/self-service/router.mjs`, `worker/index.mjs`, `wrangler.toml`, `package.json`。

**Interfaces:** Produces `serveSelfPage(request,ctx) -> Response|null`。browser は上記 HTTP 契約だけを使い、管理 API を呼ばない。
UIを実装する前に適用される frontend-design skill を読み、既存サイトの青/白・日本語案内と整合させる。

- [x] **Step 1: セキュリティヘッダと管理キー非出力を固定。**

```js
test('開始画面は秘密を含まずno-store',async()=>{
  const res=await serveSelfPage(new Request('https://meo.test/start'),
    createSelfContext({SELF_PUBLIC_ORIGIN:'https://meo.test',ADMIN_KEY:'private-fixture'}));
  assert.equal(res.headers.get('Cache-Control'),'no-store');
  assert.equal(res.headers.get('Referrer-Policy'),'no-referrer');
  assert.ok(res.headers.get('Content-Security-Policy').includes("object-src 'none'"));
  assert.ok(!(await res.text()).includes('private-fixture'));
});
```

- [x] **Step 2: unit/browser で FAIL を確認。**
- [x] **Step 3: 画面を作り、明示ルートのみ配信。**

```html
<main>
  <h1>MEO Harness を使い始める</h1>
  <p>Googleの口コミにAIが返信案を作り、LINEで承認した後だけ投稿します。</p>
  <ol aria-label="設定の進み具合" id="steps"></ol>
  <section id="current-step" aria-live="polite"></section>
  <p id="error" role="alert" hidden></p>
</main>
```

JSはstate→画面の明示マッピング、API error code→日本語/再試行ボタンの辞書で構成。外部文字列をinnerHTMLに入れない。
app.js.txt/style.css/HTML をtext importし、`/self/assets/app.js` と `/self/assets/style.css` をWorkerから返す。追加フロントフレームワークは導入しない。

```js
// views.mjsの静的import。app.js.txtをWorker内で実行しない。
import clientSource from './ui/app.js.txt';
import styleSource from './ui/style.css';
import startSource from './ui/start.html';
// scripts/build-self-test.mjsはesbuildのbuildをimportして実行。
await build({entryPoints:['worker/index.mjs'],outfile:'output/self-service/worker.mjs',
  bundle:true,format:'esm',platform:'neutral',target:'es2022',
  loader:{'.html':'text','.css':'text','.txt':'text'}});
```

WranglerにもHTML/CSS/TXTのText ruleを設定する。ローカル専用設定と架空bindingで `wrangler deploy --dry-run` を実行して解決を確認する。実Secretsや `.dev.vars` は読ませない。
packageには `"build:self-test":"node scripts/build-self-test.mjs"` を追加する。
QRは友だち追加URLのみ（秘密codeを第三者QR生成APIへ渡さない）。QRが使えなくてもリンク/コードコピーで完走可能。
PIN欄には `inputmode=numeric`, `autocomplete=one-time-code`、ラベルと期限表示。Googleから戻ったら自動で次の未完了stepへ。
危険操作はpause/disconnectそれぞれ説明と確認画面を持つ。logoutはtokenを消してstartへ。
新規 Google/LINE callback のURLを公開設定から組み立て、自己登録OFFでも既存利用者の停止画面は閉じない。
entrypointではself pathを早期dispatchし、LINE新prefixとscheduled D1処理へ振り分ける。未知パスは既存処理へ。
旧signupは自己登録公開モードで410と案内URL。legacy管理者の新規/選択にもlocation予約を通す。
wrangler既存互換日付は保持。D1本番bindingはまだ作らず、ローカル専用設定で検証する。実際の本番変更はrelease gate。

- [x] **Step 4: 375px/1280px、キーボード操作、再読込、期限切れ、Google拒否、口コミゼロ、閉鎖時login/pause可能を実行。**
- [x] **Step 5: `git commit -m "feat: add self-service onboarding and account screens"`。**

### Task 11: 通信ゼロのブラウザ E2E と案内文書

**Files:** Create `test/e2e/self-service.spec.mjs`, `test/support/self-browser.mjs`, `scripts/serve-self-test.mjs`, `playwright.config.mjs`, `docs/{quickstart,ai-setup,self-hosting}.md`, `test/self-docs.test.mjs`; Modify `README.md`, `package.json`。

**Interfaces:** Produces `startTestApp() -> {baseURL,providerFixtureURL,stop}`（loopback限定）、fixtureはGoogle認可画面/署名付きtoken/LINE番号/GBP口コミをローカルで模擬。
実productionのendpointを変えるenvフラグを作らず、test entrypointに依存注入して差し替える。

- [x] **Step 1: browser が管理 API を使わず完走するテストを書く。**

```js
test('初回導入は管理者操作なしで完走',async({page})=>{
  const adminRequests=[];
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/admin/'))adminRequests.push(r.url());});
  await page.goto('/start');
  await page.getByRole('button',{name:'Googleで接続'}).click();
  await page.getByRole('button',{name:'架空Googleで許可'}).click();
  await page.getByRole('button',{name:'この店舗を使う'}).click();
  const code=await page.getByTestId('line-code').textContent();
  await page.request.post('/fixture/line',{data:{code,userId:'line-fixture'}});
  await page.getByRole('button',{name:'確認番号をLINEに送る'}).click();
  await page.getByLabel('確認番号').fill('123456');
  await page.getByRole('button',{name:'確認する',exact:true}).click();
  await page.getByLabel('利用条件を確認しました').check();
  await page.getByRole('button',{name:'利用を開始する'}).click();
  await expect(page.getByText('稼働中',{exact:true})).toBeVisible();
  expect(adminRequests).toEqual([]);
});
```

`/fixture/*` と固定PINはtest entrypoint専用。production bundleに文字列・routeが入らないことをTask12で検査。

packageに `"test:e2e":"playwright test"` を追加し、configのbaseURLを `startTestApp()` の返却値へ固定する。CFT実行ファイルは専用インストールを検出して使い、個人Chromeのプロファイルを使わない。`__Host-` Cookieを弱めずにテストするためloopback HTTPSを使い、自己署名証明書の許可は当該test contextだけに限定する。

- [x] **Step 2: `npm run test:e2e` を実行し、導線未完成で FAIL を確認。**
- [x] **Step 3: CFT専用プロファイルとloopbackのみ許可する実行補助を実装し、文書を作る。**

```js
await context.route('**/*',route=>{
  const host=new URL(route.request().url()).hostname;
  if(['127.0.0.1','localhost'].includes(host))return route.continue();
  return route.abort('blockedbyclient');
});
```

ブラウザだけでなくWorker外部I/Oもfixture adapter以外はthrow。E2Eの予想外通信の件数が0を受入条件にする。
quickstartは画面名/手順/権限/停止、ai-setupは同じ状態codeと禁止事項、自前運用は独自GBP API承認・LINE/Cloudflare準備を別ページに分ける。
READMEは「ローカル実装済み・一般公開前」など検証した段階だけ記載。記事に即時利用可と書くのは公開gate後。
自前運用の実行例は `npm ci` → `npm test` →ローカル起動→接続検証の順で、認証値はSecret管理を案内。第三者repoへFull Accessを推奨しない。

- [x] **Step 4: 中断復帰/店0/複数/別LINE/PIN期限/枠不足/停止・切断/長文/実投稿ゼロ、docsのリンクとroute表の一致をテスト。**
- [x] **Step 5: `git commit -m "docs: add human and AI setup guides with onboarding E2E"`。**

### Task 12: 統合レビュー、公開前チェック、引き渡し

**Files:** Create `scripts/check-self-release.mjs`, `docs/self-service-release.md`, `test/self-release.test.mjs`; Modify `.gitignore`（`output/`、browserプロファイル、ローカルD1、bundle等だけ追加）。

**Interfaces:** Produces `evaluateReleaseGate(evidence) -> {ready,blocking}`。evidenceは確認日時・OAuth検証状態・quota・実接続結果・承認対象だけで、秘密値を含めない。
`check-self-release` は読み取り専用。deploy/Secret変更/課金操作を絶対に呼ばない。
exportのimportではCLIを実行しない。`import.meta.url===pathToFileURL(process.argv[1]).href` のときだけ引数処理し、証跡ファイル欠落もblocked/終了コード1とする。

- [x] **Step 1: 未確認の実接続を公開可としないテストを書く。**

```js
test('local E2E成功だけでは一般公開不可',()=>{
  const r=evaluateReleaseGate({localTests:true,browserStubE2E:true,
    oauthVerified:false,liveConnection:false,approvedRelease:false});
  assert.equal(r.ready,false);
  assert.ok(r.blocking.includes('OAUTH_VERIFICATION'));
  assert.ok(r.blocking.includes('LIVE_CONNECTION'));
});
```

- [x] **Step 2: `node --test test/self-release.test.mjs` → FAIL。**
- [x] **Step 3: gateを明示条件で実装。**

```js
const required={
  OAUTH_VERIFICATION:evidence.oauthVerified===true,
  QUOTA_LIMITS:evidence.quotaChecked===true,
  LOCAL_TESTS:evidence.localTests===true,
  BROWSER_STUB_E2E:evidence.browserStubE2E===true,
  LIVE_CONNECTION:evidence.liveConnection===true,
  STOP_FLOW:evidence.liveStopVerified===true,
  PRIVACY:evidence.privacyReviewed===true,
  APPROVAL:evidence.approvedRelease===true,
};
const blocking=Object.keys(required).filter(k=>!required[k]);
return {ready:blocking.length===0,blocking};
```

公開前手順にはGoogle表示名/domain/redirect/scope検証、D1作成・暗号鍵追加、legacy location予約、LINE実残量・他サービス確保枠、ログの秘密除外、実接続と停止の確認を列挙。
Secretや資格情報の変更とremote DB作成は、対象を示して別途承認。既存店舗を触るlive testは本人が承認した店だけ。
証跡ファイルは実行したlocal検証結果と実行日時だけから生成し、OAuth/live/公開承認の各欄は確認できるまでfalseに固定する。空ファイルや口頭推測でtrueにしない。バックアップ保持期間の実設定もprivacy確認に含める。
公開版bundleに `/fixture/`、固定PIN、test用鍵、認証迂回フラグが入っていないことをスキャンする。
安全停止は新規受付OFF/新規処理OFF、account停止・切断は維持。D1移行を破棄するrollbackを自動実行しない。

- [x] **Step 4: 全検証をraw exit付きで実行。**

```bash
npm test
npm run test:self-runtime
npm run build:self-test
npm run test:e2e
node scripts/check-self-release.mjs --evidence output/self-service/release-evidence.json
git diff --check
```

最後のgateはlive承認前には非zero/blockedが正しい。local test成功とは別に報告する。
テスト件数・fail/skip・元終了コードをそのまま保存し、要約だけで判定しない。
全差分、トークン保存、ID照合、停止後投稿、残量超過、legacy回帰をCodexがレビューする。
新たな重大問題は原因→失敗テスト→修正→再テストの順。初回美容院の試用まで一般公開を待たせるのではなく、公開gate固有の不足だけを提示する。

- [x] **Step 5: `git commit -m "test: verify self-service readiness and release gates"`。**
レビュー済みworktreeをmainへ採用する場合はgit merge/cherry-pickのみ。サイト側の既存変更の状態を再確認して入口リンクを統合し、公開は別途確認する。

---

## 設計への対応と実装計画セルフレビュー

| 設計節 | 担当Task | 完了判定 |
|---|---|---|
| 1/3 目的・主経路 | 4–6,10–11 | admin APIなしのE2E |
| 4 状態・再開・失敗 | 3–7,10–11 | 状態遷移とbrowser復帰 |
| 5 保存責任・既存維持 | 1–2,8,10,12 | D1競合テスト＋legacy全件 |
| 6 認証と公開安全 | 3–6,9–10 | 本人偽装/再送/既存返信競合拒否 |
| 7 利用量・保存期間 | 7–8,12 | concurrency/retention/残枠0 |
| 8 AI向け案内 | 11 | 文書と実route一致 |
| 9 対象外の維持 | 全Task/12 | 課金・拡大機能・外部変更なし |
| 10 受入検証 | 全Task/11–12 | unit/runtime/CFTそれぞれ成功 |
| 11 公開gate | 12 | live未確認を公開可としない |

実装時に追加する依存は上記限定で、勝手にSupabaseや別認証サービスを足さない。
表のタスク間接口は本書の関数名に統一。返却がnullになるケースを呼出側で扱う。
本文中のfixtureキー・PINは架空。Secretsを検証ログへ混ぜない。

## 実行状況

2026-09-27の承認後、`executing-plans`で隔離ブランチに実装・ローカル検証。同日の本人の判断委任を受け、`main`へfast-forward統合し、Node 179件・D1 46件・CFT 10シナリオを統合前後で再検証しました。外部設定・push・一般公開は未実施。実装時の検証ログと判断は当該計画のSDD ledger、統合時のログはmain側の`.superpowers/integration-2026-09-27/`に保存。
本番公開の承認は、実装を進める承認と分ける。

## 参照（2026-09-27確認）

- [Miniflare D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/)
- [D1 batch/transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Google OAuth Web Server](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
- [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
- [LINE retry key・24時間の有効期間](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)

依存versionはnpmレジストリmetadataを読取確認。最新Vitest/Workers pluginは既存node:testの置換を必要とせず、この計画では採用しない。Miniflareは確認済み4系を明示固定してalpha版への自動追随を避ける。
