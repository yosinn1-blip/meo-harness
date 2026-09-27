import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { buildReviewBubble } from '../src/line-flex.mjs';

function setup(t, output) {
  const store = { apiKey: 'fixture', businessName: '架空店', businessType: '美容室', lineUserId: 'fixture-user', lineChannelToken: 'fixture' };
  const values = new Map([['store:s', JSON.stringify(store)]]);
  const pushes = [];
  let aiCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).hostname === 'api.groq.com') {
      aiCalls++;
      return Response.json({ choices: [{ message: { content: output } }], usage: { total_tokens: 10 } });
    }
    if (new URL(url).hostname === 'api.line.me') {
      pushes.push(JSON.parse(init.body));
      return Response.json({});
    }
    throw new Error('UNEXPECTED_EXTERNAL_IO');
  });
  const env = { GROQ_API_KEY: 'fixture', LINE_CHANNEL_ACCESS_TOKEN: 'fixture', STORES: {
    get: async k => values.get(k), put: async (k, v) => values.set(k, v), delete: async k => values.delete(k),
    list: async ({ prefix }) => ({ keys: [...values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }),
  } };
  return { env, values, pushes, store, aiCalls: () => aiCalls, setOutput: text => { output = text; } };
}

for (const valid of [false, true]) {
  test(`legacy ingestion ${valid ? 'retains approval for valid drafts' : 'withholds invalid drafts from KV and notifications'}`, async t => {
    const { env, values, pushes, aiCalls } = setup(t, valid ? 'ご来店ありがとうございました。' : 'Thank you for your review.');
    const response = await worker.fetch(new Request('https://meo.test/review', {
      method: 'POST', headers: { 'X-API-Key': 'fixture' },
      body: JSON.stringify({ storeId: 's', reviews: [{ reviewId: 'r', star: 5, text: '良かったです' }] }),
    }), env, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).failed, valid ? 0 : 1);
    assert.equal([...values.keys()].filter(k => k.startsWith('reply:')).length, valid ? 1 : 0);
    assert.equal(pushes.length, 1);
    assert.equal(JSON.stringify(pushes).includes('approve:'), valid);
    assert.equal(JSON.stringify(pushes).includes('Thank you'), false);
    assert.equal(aiCalls(), valid ? 1 : 2);
  });
}

test('pending digest cannot expose stale approval ID after regeneration fails', async t => {
  const { env, store, values, pushes, aiCalls } = setup(t, 'Thank you for your review.');
  values.set('store:s', JSON.stringify({ ...store, utcOffset: 9 - new Date().getUTCHours() }));
  values.set('pending:s', JSON.stringify([{ reviewId: 'r', replyId: 'old', star: 5, text: '良かったです', draft: '古い案です。' }]));
  await worker.scheduled({}, env, {});
  assert.equal(aiCalls(), 2);
  assert.equal(pushes.length, 1);
  assert.equal(JSON.stringify(pushes).includes('approve:'), false);
  assert.equal(JSON.stringify(pushes).includes('Thank you'), false);
});

test('empty draft never renders an approval button even if replyId survives upstream', () => {
  const bubble = buildReviewBubble({ replyId: 'old', review: { star: 5, text: '良かったです', draft: '' } });
  assert.equal(JSON.stringify(bubble).includes('approve:'), false);
});

for (const initial of ['Thank you for your review.', 'ご来店ありがとうございました。']) {
  test(`daily digest stores exactly the newly generated approval text after ${initial.startsWith('Thank') ? 'rejection' : 'success'}`, async t => {
    const { env, values, pushes, store, setOutput } = setup(t, initial);
    values.set('store:s', JSON.stringify({ ...store, notifyMode: 'daily-digest', utcOffset: 9 - new Date().getUTCHours() }));
    const response = await worker.fetch(new Request('https://meo.test/review', {
      method: 'POST', headers: { 'X-API-Key': 'fixture' },
      body: JSON.stringify({ storeId: 's', reviews: [{ reviewId: 'r', star: 5, text: '良かったです' }] }),
    }), env, {});
    assert.equal(response.status, 200);
    const regenerated = 'ご評価ありがとうございます。またのご来店をお待ちしております。';
    setOutput(regenerated);
    await worker.scheduled({}, env, {});
    assert.equal(pushes.length, 1);
    const payload = JSON.stringify(pushes[0]);
    const id = payload.match(/approve:([^"\\]+)/)?.[1];
    assert.ok(id, 'recovered draft must have an approval action');
    assert.equal(JSON.parse(values.get('reply:' + id)).draft, regenerated);
    assert.ok(payload.includes(regenerated));
  });
}
