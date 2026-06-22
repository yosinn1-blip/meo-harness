// 決定的ユニットテスト（ライブAPIを叩かない・モックfetch）
// 実行: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendDigest } from '../src/notify.mjs';

const sampleReviews = [
  { star: 5, text: 'Great service!', draft: 'Thank you for your wonderful review!' },
];

const lineStore = {
  notificationChannel: 'line',
  lineChannelToken: 'TOKEN_LINE',
  lineUserId: 'U_LINE_123',
  businessName: 'Test Store',
};

const telegramStore = {
  notificationChannel: 'telegram',
  telegramBotToken: '123456:BOT_TOKEN',
  telegramChatId: '-1001234567890',
  businessName: 'Test Store',
};

// ── LINE ─────────────────────────────────────────────────────────────────────

test('sendDigest: LINE チャネルは LINE push API に転送する', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const res = await sendDigest({ store: lineStore, reviews: sampleReviews, fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.ok(captured.url.includes('line.me'), `expected LINE URL, got ${captured.url}`);
  assert.match(captured.init.headers.Authorization, /Bearer TOKEN_LINE/);
});

test('sendDigest: notificationChannel 未設定は LINE をデフォルトにする', async () => {
  const store = { ...lineStore, notificationChannel: undefined };
  let lineCalled = false;
  const mockFetch = async (url) => {
    if (url.includes('line.me')) lineCalled = true;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await sendDigest({ store, reviews: sampleReviews, fetchImpl: mockFetch });
  assert.ok(lineCalled, 'LINE API should have been called');
});

// ── Telegram ──────────────────────────────────────────────────────────────────

test('sendDigest: Telegram チャネルは Bot API sendMessage を呼ぶ', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const res = await sendDigest({ store: telegramStore, reviews: sampleReviews, fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.ok(captured.url.includes('api.telegram.org'), `expected Telegram URL, got ${captured.url}`);
  assert.ok(captured.url.includes(telegramStore.telegramBotToken), 'URL should include bot token');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.chat_id, telegramStore.telegramChatId);
  assert.ok(typeof body.text === 'string' && body.text.length > 0, 'message text should be non-empty');
});

test('sendDigest: Telegram メッセージにクチコミ件数が含まれる', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  await sendDigest({ store: telegramStore, reviews: sampleReviews, fetchImpl: mockFetch });
  const body = JSON.parse(captured.init.body);
  assert.match(body.text, /1件|1 review/i);
});

test('sendDigest: Telegram dryRun はペイロードを返すが fetch しない', async () => {
  let called = false;
  const mockFetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const res = await sendDigest({ store: telegramStore, reviews: sampleReviews, dryRun: true, fetchImpl: mockFetch });
  assert.equal(called, false, 'fetch should not be called in dryRun');
  assert.equal(res.dryRun, true);
  assert.equal(res.sent, 0);
  assert.ok(res.payload?.chat_id, 'payload should include chat_id');
});

test('sendDigest: Telegram API が ok:false を返すと例外を投げる', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
  });
  await assert.rejects(
    sendDigest({ store: telegramStore, reviews: sampleReviews, fetchImpl: mockFetch }),
    /chat not found|Bad Request/,
  );
});

// ── 共通 ──────────────────────────────────────────────────────────────────────

test('sendDigest: 新着0件はスキップ（チャネル問わず）', async () => {
  const res = await sendDigest({ store: lineStore, reviews: [] });
  assert.equal(res.sent, 0);
  assert.ok(res.skipped);
});

test('sendDigest: 未知のチャネルは例外を投げる', async () => {
  const store = { ...lineStore, notificationChannel: 'sms' };
  await assert.rejects(
    sendDigest({ store, reviews: sampleReviews }),
    /Unknown|未知/i,
  );
});

// ── WhatsApp ──────────────────────────────────────────────────────────────────

const whatsappStore = {
  notificationChannel: 'whatsapp',
  whatsappRecipient: '819014479105',
  whatsappToken: 'TOKEN_WA',
  whatsappPhoneNumberId: '1222481350942430',
  businessName: 'Test Store',
};

test('sendDigest: WhatsApp チャネルは Graph API に転送する', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x', message_status: 'accepted' }] }) };
  };
  const res = await sendDigest({ store: whatsappStore, reviews: sampleReviews, fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.ok(captured.url.includes('graph.facebook.com'), `expected Graph API URL, got ${captured.url}`);
  assert.match(captured.init.headers['Authorization'], /Bearer TOKEN_WA/);
});

test('sendDigest: WhatsApp ペイロードに件数が渡る', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'id', message_status: 'accepted' }] }) };
  };
  const reviews = [sampleReviews[0], sampleReviews[0]];
  await sendDigest({ store: whatsappStore, reviews, fetchImpl: mockFetch });
  const body = JSON.parse(captured.init.body);
  const bodyComp = body.template.components?.find(c => c.type === 'body');
  assert.ok(bodyComp, 'body component should exist');
  assert.equal(bodyComp.parameters[1].text, '2', 'count should be 2');
});

test('sendDigest: WhatsApp dryRun は fetch しない', async () => {
  let called = false;
  const mockFetch = async () => { called = true; };
  const res = await sendDigest({ store: whatsappStore, reviews: sampleReviews, dryRun: true, fetchImpl: mockFetch });
  assert.equal(called, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.sent, 0);
});
