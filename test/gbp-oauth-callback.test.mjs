import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';

// 旧 OAuth 戻り先は店主のログイン Cookie と同じドメインにある。
// 誰でも作れるリンクの値が HTML として動かないことを確かめる。
const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function setup(t, { token = () => Response.json({ error: 'invalid_grant' }, { status: 400 }), values = new Map() } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    calls.push(u.origin + u.pathname);
    if (u.hostname === 'oauth2.googleapis.com') return token(init);
    throw Error('UNEXPECTED_EXTERNAL_IO');
  });
  const env = {
    GBP_OAUTH_CLIENT_ID: 'fixture-client',
    GBP_OAUTH_CLIENT_SECRET: 'fixture-secret',
    STORES: {
      get: async k => values.get(k) ?? null,
      put: async (k, v) => { values.set(k, v); },
      delete: async k => { values.delete(k); },
    },
  };
  return { env, calls, values };
}

function callback(params) {
  const u = new URL('https://meo.test/gbp/oauth/callback');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Request(u);
}

function assertSafeHtml(res) {
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('Content-Security-Policy'), CSP);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
}

for (const payload of [
  '<script>alert(1)</script>',
  '<i id=meo-audit-marker>x</i>',
  '"><img src=x onerror=alert(1)>',
  'access_denied<svg/onload=alert(1)>',
]) {
  test('旧 OAuth 戻り先は error の値を HTML として返さない: ' + payload, async t => {
    const { env, calls } = setup(t);
    const res = await worker.fetch(callback({ error: payload }), env, {});
    assert.equal(res.status, 400);
    assertSafeHtml(res);
    const body = await res.text();
    assert.ok(!body.includes(payload), body);
    assert.ok(!/<script|<img|<svg|<i id/i.test(body), body);
    assert.match(body, /<code>unknown_error<\/code>/);
    assert.deepEqual(calls, []);
  });
}

test('Google が返す通常の error 名は従来どおり表示する', async t => {
  const { env } = setup(t);
  const res = await worker.fetch(callback({ error: 'access_denied' }), env, {});
  assert.equal(res.status, 400);
  assertSafeHtml(res);
  assert.match(await res.text(), /<code>access_denied<\/code>/);
});

test('トークン応答の文言と店舗 ID もエスケープし、トークンの JSON は画面に出さない', async t => {
  const storeId = 'shop<script>x</script>';
  const values = new Map([
    ['gbp-oauth-state:fixture-state', storeId],
  ]);
  const { env } = setup(t, {
    values,
    token: () => Response.json({ error_description: '<b>bad</b><script>x</script>' }, { status: 400 }),
  });
  const res = await worker.fetch(callback({ code: 'fixture-code', state: 'fixture-state' }), env, {});
  assert.equal(res.status, 500);
  assertSafeHtml(res);
  const body = await res.text();
  assert.ok(!body.includes('<script>'), body);
  assert.ok(body.includes('&lt;b&gt;bad&lt;/b&gt;'), body);

  values.set('gbp-oauth-state:fixture-state-2', storeId);
  const { env: env2 } = setup(t, {
    values,
    token: () => Response.json({ access_token: 'fixture-access-token-should-not-show' }),
  });
  const noRefresh = await worker.fetch(callback({ code: 'fixture-code', state: 'fixture-state-2' }), env2, {});
  assert.equal(noRefresh.status, 500);
  const noRefreshBody = await noRefresh.text();
  assert.ok(!noRefreshBody.includes('fixture-access-token-should-not-show'), noRefreshBody);

  values.set('gbp-oauth-state:fixture-state-3', storeId);
  const { env: env3 } = setup(t, {
    values,
    token: () => Response.json({ refresh_token: 'fixture-refresh' }),
  });
  const missing = await worker.fetch(callback({ code: 'fixture-code', state: 'fixture-state-3' }), env3, {});
  assert.equal(missing.status, 404);
  assertSafeHtml(missing);
  const missingBody = await missing.text();
  assert.ok(!missingBody.includes('<script>'), missingBody);
  assert.ok(missingBody.includes('shop&lt;script&gt;x&lt;/script&gt;'), missingBody);
});

test('認証完了画面も店舗 ID をエスケープし、正規の保存は続く', async t => {
  const storeId = 'shop"<b>';
  const values = new Map([
    ['gbp-oauth-state:ok-state', storeId],
    [`store:${storeId}`, JSON.stringify({ businessName: '架空試験店' })],
  ]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    calls.push(u.hostname);
    if (u.hostname === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(init.body);
      return Response.json(form.get('grant_type') === 'refresh_token'
        ? { access_token: 'fixture-access' }
        : { refresh_token: 'fixture-refresh' });
    }
    // 店舗の自動選択は失敗してもよい（認証は保存される）
    return Response.json({}, { status: 500 });
  });
  const env = {
    GBP_OAUTH_CLIENT_ID: 'fixture-client',
    GBP_OAUTH_CLIENT_SECRET: 'fixture-secret',
    STORES: {
      get: async k => values.get(k) ?? null,
      put: async (k, v) => { values.set(k, v); },
      delete: async k => { values.delete(k); },
    },
  };
  const res = await worker.fetch(callback({ code: 'fixture-code', state: 'ok-state' }), env, {});
  assert.equal(res.status, 200);
  assertSafeHtml(res);
  const body = await res.text();
  assert.ok(!body.includes('<b>'), body);
  assert.ok(body.includes('shop&quot;&lt;b&gt;'), body);
  assert.equal(JSON.parse(values.get(`store:${storeId}`)).gbpRefreshToken, 'fixture-refresh');
  assert.equal(values.has('gbp-oauth-state:ok-state'), false);
});
