import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHmac } from '../src/hmac.mjs';

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

test('verifyHmac: 正しい HMAC は true を返す', async () => {
  const secret = 'my-secret';
  const body = '{"star":5,"text":"great"}';
  const sig = sign(secret, body);
  assert.equal(await verifyHmac(secret, body, sig), true);
});

test('verifyHmac: 大文字16進でも true を返す', async () => {
  const secret = 'my-secret';
  const body = 'hello';
  const sig = sign(secret, body).toUpperCase();
  assert.equal(await verifyHmac(secret, body, sig), true);
});

test('verifyHmac: 間違った secret は false を返す', async () => {
  const body = 'hello';
  const sig = sign('correct-secret', body);
  assert.equal(await verifyHmac('wrong-secret', body, sig), false);
});

test('verifyHmac: ボディを改ざんすると false を返す', async () => {
  const secret = 'sec';
  const sig = sign(secret, 'original');
  assert.equal(await verifyHmac(secret, 'tampered', sig), false);
});

test('verifyHmac: 空の signature は false を返す', async () => {
  assert.equal(await verifyHmac('sec', 'body', ''), false);
});

test('verifyHmac: 空の secret は false を返す', async () => {
  const sig = sign('sec', 'body');
  assert.equal(await verifyHmac('', 'body', sig), false);
});

test('verifyHmac: 日本語ボディも正しく検証できる', async () => {
  const secret = 'テストシークレット';
  const body = '{"text":"良い店でした"}';
  const sig = sign(secret, body);
  assert.equal(await verifyHmac(secret, body, sig), true);
});

test('verifyHmac: 空ボディも正しく検証できる', async () => {
  const secret = 'sec';
  const body = '';
  const sig = sign(secret, body);
  assert.equal(await verifyHmac(secret, body, sig), true);
});
