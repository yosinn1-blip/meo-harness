import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { workersDevRedirect } from '../worker/index.mjs';

// 独自ドメインへ移したあとも、workers.dev の画面リンクは新しいアドレスへ転送する。
// サーバー間の呼び出し（Webhook・API・OAuth 戻り先）と所有権確認ファイルは転送しない。
const OLD = 'https://meo-harness.yosinn1.workers.dev';
const NEW = 'https://meo.star-pocket.com';
const env = { SELF_PUBLIC_ORIGIN: NEW };

function req(path, method = 'GET', base = OLD) {
  return new Request(base + path, { method });
}

for (const path of [
  '/', '/start', '/account', '/account/replies/ss_abc-123',
  '/self/privacy', '/self/terms', '/self/help/faq', '/self/assets/app.js',
]) {
  for (const method of ['GET', 'HEAD']) {
    test(`workers.dev の画面 ${method} ${path} は新しいアドレスへ301`, () => {
      const res = workersDevRedirect(req(path, method), env);
      assert.ok(res, 'redirect expected');
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('Location'), NEW + path);
      assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
      assert.equal(res.headers.get('Set-Cookie'), null);
    });
  }
}

test('クエリ文字列はそのまま残す', () => {
  const res = workersDevRedirect(req('/start?openExternalBrowser=1&x=a%20b'), env);
  assert.equal(res.headers.get('Location'), NEW + '/start?openExternalBrowser=1&x=a%20b');
});

for (const path of [
  '/google3031925227c81399.html', '/api/self/status', '/api/self/google/callback?state=s&code=c',
  '/webhook/line-bot', '/webhook/whatsapp', '/gbp/oauth/callback?code=c', '/health',
  '/admin/stores/x/status', '/signup', '/review', '/startx', '/accounts', '/selfie', '/favicon.ico',
]) {
  test(`転送しない: GET ${path}`, () => {
    assert.equal(workersDevRedirect(req(path), env), null);
  });
}

for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
  test(`GET/HEAD 以外は画面パスでも転送しない: ${method}`, () => {
    assert.equal(workersDevRedirect(req('/start', method), env), null);
    assert.equal(workersDevRedirect(req('/webhook/line-bot', method), env), null);
  });
}

test('新しいアドレス自身・localhost では転送しない', () => {
  assert.equal(workersDevRedirect(req('/start', 'GET', NEW), env), null);
  assert.equal(workersDevRedirect(req('/start', 'GET', 'http://localhost:8787'), env), null);
});

test('SELF_PUBLIC_ORIGIN が workers.dev のまま・未設定・不正なら転送しない（戻したときに無害）', () => {
  assert.equal(workersDevRedirect(req('/start'), { SELF_PUBLIC_ORIGIN: OLD }), null);
  assert.equal(workersDevRedirect(req('/start'), {}), null);
  assert.equal(workersDevRedirect(req('/start'), { SELF_PUBLIC_ORIGIN: 'http://meo.star-pocket.com' }), null);
  assert.equal(workersDevRedirect(req('/start'), { SELF_PUBLIC_ORIGIN: NEW + '/' }), null);
  assert.equal(workersDevRedirect(req('/start'), { SELF_PUBLIC_ORIGIN: 'https://other.yosinn1.workers.dev' }), null);
});

test('Worker の入口でも、DBや外部通信より先に転送する', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('UNEXPECTED_EXTERNAL_IO'); });
  const res = await worker.fetch(req('/account/replies/ss_x?y=1'), env, {});
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), NEW + '/account/replies/ss_x?y=1');
});

test('Worker の入口: workers.dev の /health は転送せず今までどおり200', async () => {
  const res = await worker.fetch(req('/health'), { ...env, VERSION: 't' }, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', version: 't' });
});
