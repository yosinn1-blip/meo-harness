import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhatsAppPayload, sendWhatsAppDigest } from '../src/whatsapp-notify.mjs';

function mockFetch(status, body) {
  return async () => ({
    ok: status < 400,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => JSON.stringify(body),
  });
}

// ── buildWhatsAppPayload ──────────────────────────────────────────────────────

test('buildWhatsAppPayload: hello_world テンプレートは en_US・変数なし', () => {
  const p = buildWhatsAppPayload({ to: '819014479105', bizName: 'テスト', count: 2, templateName: 'hello_world' });
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '819014479105');
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'hello_world');
  assert.equal(p.template.language.code, 'en_US');
  assert.equal(p.template.components, undefined);
});

test('buildWhatsAppPayload: meo_harness_review テンプレートは body 変数 2つ', () => {
  const p = buildWhatsAppPayload({ to: '819014479105', bizName: '山田カフェ', count: 3 });
  assert.equal(p.template.name, 'meo_harness_review');
  assert.equal(p.template.language.code, 'ja');
  const body = p.template.components.find(c => c.type === 'body');
  assert.ok(body, 'body component should exist');
  assert.equal(body.parameters.length, 2);
  assert.equal(body.parameters[0].text, '山田カフェ');
  assert.equal(body.parameters[1].text, '3');
});

test('buildWhatsAppPayload: カスタムテンプレート名・言語コード', () => {
  const p = buildWhatsAppPayload({ to: '810000000000', bizName: 'カフェ', count: 1, templateName: 'my_template', templateLang: 'en' });
  assert.equal(p.template.name, 'my_template');
  assert.equal(p.template.language.code, 'en');
});

test('buildWhatsAppPayload: count は文字列に変換される', () => {
  const p = buildWhatsAppPayload({ to: '819014479105', bizName: 'テスト', count: 5 });
  const body = p.template.components.find(c => c.type === 'body');
  assert.equal(typeof body.parameters[1].text, 'string');
  assert.equal(body.parameters[1].text, '5');
});

test('buildWhatsAppPayload: bizName が未設定でも落ちない', () => {
  const p = buildWhatsAppPayload({ to: '819014479105', count: 1 });
  const body = p.template.components.find(c => c.type === 'body');
  assert.equal(body.parameters[0].text, '店舗');
});

// ── sendWhatsAppDigest ────────────────────────────────────────────────────────

test('sendWhatsAppDigest: dryRun=true → API を叩かずペイロードを返す', async () => {
  let called = false;
  const mockFetchSpy = async () => { called = true; };
  const result = await sendWhatsAppDigest({
    phoneNumberId: 'pid', token: 'tok', to: '819014479105',
    bizName: 'テスト', count: 2, dryRun: true, fetchImpl: mockFetchSpy,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, 0);
  assert.ok(result.payload);
  assert.equal(called, false, 'fetch should not be called in dryRun');
});

test('sendWhatsAppDigest: 成功 → messageId と sent=1 を返す', async () => {
  const responseBody = {
    messages: [{ id: 'wamid.abc123', message_status: 'accepted' }],
  };
  const result = await sendWhatsAppDigest({
    phoneNumberId: '1222481350942430',
    token: 'valid-token',
    to: '819014479105',
    bizName: 'テストカフェ',
    count: 3,
    fetchImpl: mockFetch(200, responseBody),
  });
  assert.equal(result.sent, 1);
  assert.equal(result.messageId, 'wamid.abc123');
  assert.equal(result.status, 'accepted');
});

test('sendWhatsAppDigest: 401 → エラー（トークン無効）', async () => {
  const errorBody = { error: { message: 'Invalid OAuth access token', code: 190 } };
  await assert.rejects(
    () => sendWhatsAppDigest({
      phoneNumberId: 'pid', token: 'bad-token', to: '819014479105',
      bizName: 'テスト', count: 1, fetchImpl: mockFetch(401, errorBody),
    }),
    /WhatsApp 401/,
  );
});

test('sendWhatsAppDigest: 400 → エラー（テンプレート未承認）', async () => {
  const errorBody = { error: { message: 'Template not found', code: 132000 } };
  const err = await sendWhatsAppDigest({
    phoneNumberId: 'pid', token: 'tok', to: '819014479105',
    bizName: 'テスト', count: 1, fetchImpl: mockFetch(400, errorBody),
  }).catch(e => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /WhatsApp 400/);
  assert.equal(err.code, 132000);
});

test('sendWhatsAppDigest: to が未設定 → エラー', async () => {
  await assert.rejects(
    () => sendWhatsAppDigest({ phoneNumberId: 'pid', token: 'tok', to: '', bizName: 'x', count: 1 }),
    /whatsappRecipient/,
  );
});

test('sendWhatsAppDigest: dryRun=false で token 未設定 → エラー', async () => {
  await assert.rejects(
    () => sendWhatsAppDigest({ phoneNumberId: 'pid', token: '', to: '819014479105', bizName: 'x', count: 1 }),
    /WHATSAPP_TOKEN/,
  );
});

test('sendWhatsAppDigest: dryRun=false で phoneNumberId 未設定 → エラー', async () => {
  await assert.rejects(
    () => sendWhatsAppDigest({ phoneNumberId: '', token: 'tok', to: '819014479105', bizName: 'x', count: 1 }),
    /WHATSAPP_PHONE_NUMBER_ID/,
  );
});

test('sendWhatsAppDigest: fetch に正しい Authorization ヘッダーが渡る', async () => {
  let capturedHeaders;
  const spyFetch = async (url, init) => {
    capturedHeaders = init.headers;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'id1', message_status: 'accepted' }] }) };
  };
  await sendWhatsAppDigest({
    phoneNumberId: 'pid', token: 'my-secret-token', to: '819014479105',
    bizName: 'テスト', count: 1, fetchImpl: spyFetch,
  });
  assert.match(capturedHeaders['Authorization'], /Bearer my-secret-token/);
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
});

test('sendWhatsAppDigest: URL に phoneNumberId が含まれる', async () => {
  let capturedUrl;
  const spyFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'id1', message_status: 'accepted' }] }) };
  };
  await sendWhatsAppDigest({
    phoneNumberId: 'test-phone-id', token: 'tok', to: '819014479105',
    bizName: 'テスト', count: 1, fetchImpl: spyFetch,
  });
  assert.ok(capturedUrl.includes('test-phone-id'), `URL should contain phoneNumberId, got: ${capturedUrl}`);
  assert.ok(capturedUrl.includes('graph.facebook.com'), `URL should be Graph API, got: ${capturedUrl}`);
});
