import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../worker/self-service/ui/home.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../worker/self-service/ui/home.css', import.meta.url), 'utf8');
const assets = [
  { name: 'hero-phone.webp', bytes: 69140, sha256: 'bc70040e4557d735c567f45a255cc77b27509b59057abdf1f1af2064f320f12b', width: 1122, height: 1402 },
  { name: 'flow-review.webp', bytes: 11118, sha256: '9d834a643b63fa4281b7ca0de974b378f904cabf9d76cca113a3fb0f3b46c830', width: 1536, height: 1024 },
  { name: 'flow-draft.webp', bytes: 13216, sha256: '410180c005943a00c8b3b912f3c2deccb445f27d64ecf7be211c081edb989e1d', width: 1536, height: 1024 },
  { name: 'flow-send.webp', bytes: 13444, sha256: '4ec2398d85dfb0e3ce1b9397703a464d0ed8cc314b2f9ee20b512607dc5c88ba', width: 1536, height: 1024 },
];
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const attrs = name => [...html.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map(match => match[1]);

test('visual homepage uses the approved concise headline and human-controlled flow', () => {
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  for (const text of ['口コミ返信を、', 'いつものLINEで。', 'AIが下書き。あなたが確認して送信。', '確認してから公開', '先着10店舗', '月30件まで', '1つのGoogleアカウントで1店舗'])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /ずっと無料|登録も1タップ|集客を保証/);
});

test('visual homepage has exactly four same-origin explanatory images with reserved dimensions', () => {
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  assert.equal(images.length, 4);
  for (const asset of assets) {
    const matching = images.filter(tag => attribute(tag, 'src') === '/self/assets/' + asset.name);
    assert.equal(matching.length, 1, asset.name);
    assert.ok((attribute(matching[0], 'alt') ?? '').trim().length > 0, asset.name + ': meaningful alt');
    assert.equal(attribute(matching[0], 'width'), String(asset.width));
    assert.equal(attribute(matching[0], 'height'), String(asset.height));
    if (asset.name === 'hero-phone.webp') {
      assert.equal(attribute(matching[0], 'fetchpriority'), 'high');
      assert.notEqual(attribute(matching[0], 'loading'), 'lazy');
    } else assert.equal(attribute(matching[0], 'loading'), 'lazy');
  }
  assert.match(html, /画面はイメージです/);
  assert.match(html, /架空/);
  assert.doesNotMatch(html, /<svg\b|<canvas\b|data:image/);
});

test('visual homepage preserves unique anchor targets and native closed disclosure controls', () => {
  const ids = attrs('id');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['main-content', 'features', 'steps', 'pricing', 'faq']) assert.ok(ids.includes(id), id);
  for (const href of attrs('href').filter(value => value.startsWith('#') && value !== '#'))
    assert.ok(ids.includes(href.slice(1)), href);
  const disclosures = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  assert.ok(disclosures.length >= 6, 'registration instructions plus five FAQs');
  for (const [, attributes, body] of disclosures) {
    assert.doesNotMatch(attributes, /\bopen\b/);
    assert.match(body, /<summary\b[^>]*>[\s\S]+?<\/summary>/);
    assert.ok(body.replace(/<[^>]*>/g, '').trim().length > 20);
  }
});

test('visual homepage remains an indexable, script-free production page with existing routes', () => {
  assert.match(html, /<html\b[^>]*lang="ja"/);
  assert.match(html, /<meta\b[^>]*name="description"/);
  for (const route of ['/start', '/account', '/self/terms', '/self/privacy', '/self/help/faq', '/self/help/report'])
    assert.ok(attrs('href').includes(route), route);
  assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b|fetch\(|localStorage|sessionStorage|XMLHttpRequest/);
  assert.doesNotMatch(html, /noindex|デザイン確認用|本番サイトは変更していません/);
  assert.match(css, /@media[\s\S]*max-width:\s*\d+/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

let compiledWorker;
async function worker() {
  compiledWorker ??= import('../scripts/build-self-test.mjs').then(async ({ buildWorker }) => (await import(await buildWorker())).default);
  return compiledWorker;
}
const noStateEnv = {
  SELF_DB: { prepare() { throw new Error('Public image must not use DB'); } },
  STORES: { get() { throw new Error('Public image must not use KV'); } },
};
function assertPublicHeaders(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Location'), null);
  assert.match(response.headers.get('Content-Security-Policy'), /object-src 'none'; base-uri 'none';/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
}

for (const asset of assets) {
  test('home image GET preserves approved WebP bytes without DB access: ' + asset.name, async () => {
    const response = await (await worker()).fetch(new Request('https://meo.test/self/assets/' + asset.name + '?v=contract'), noStateEnv, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/webp');
    assertPublicHeaders(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    assert.deepEqual(bytes, readFileSync(new URL('../worker/self-service/ui/images/' + asset.name, import.meta.url)));
  });
}

test('home images reject non-GET methods and unknown asset paths', async () => {
  const app = await worker();
  for (const asset of assets) for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await app.fetch(new Request('https://meo.test/self/assets/' + asset.name, { method }), noStateEnv, {});
    assert.equal(response.status, 405, method + ' ' + asset.name);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  for (const path of ['/self/assets/missing.webp', '/self/assets/hero-phone.webp/extra', '/self/assets/hero-phone.png', '/self/assets/__proto__.webp']) {
    const response = await app.fetch(new Request('https://meo.test' + path), noStateEnv, {});
    assert.equal(response.status, 404, path);
  }
});

test('home retains strict no-script CSP and image budget after adding local illustrations', async () => {
  const response = await (await worker()).fetch(new Request('https://meo.test/'), noStateEnv, {});
  assert.equal(response.status, 200);
  assertPublicHeaders(response);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.ok(assets.reduce((sum, asset) => sum + asset.bytes, 0) < 160_000);
});
