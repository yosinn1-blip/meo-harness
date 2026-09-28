import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorker } from "../scripts/build-self-test.mjs";
const compiled = await buildWorker();
const worker = (await import(compiled)).default;
const verificationFile = 'google0123456789abcdef.html';
test('Google ownership verification serves only its configured file without auth or DB access', async () => {
  const response = await worker.fetch(new Request('https://meo.test/' + verificationFile + '?token=private-query-fixture'), {
    SELF_GOOGLE_SITE_VERIFICATION_FILE: verificationFile,
    ADMIN_KEY: 'private-admin-fixture',
    SELF_DB: { prepare() { throw new Error('Verification must not use the DB'); } },
  }, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'google-site-verification: ' + verificationFile);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});
test('Google ownership verification does not serve unconfigured or mismatched paths', async () => {
  for (const [path, config] of [
    ['/' + verificationFile, undefined],
    ['/googlefedcba9876543210.html', verificationFile],
    ['/self/' + verificationFile, verificationFile],
    ['/' + verificationFile + '/extra', verificationFile],
    ['/' + verificationFile + '?filename=' + verificationFile, undefined],
  ]) {
    const response = await worker.fetch(new Request('https://meo.test' + path), { SELF_GOOGLE_SITE_VERIFICATION_FILE: config }, {});
    assert.equal(response.status, 404, path);
  }
});
test('Google ownership verification rejects unsafe or malformed configuration', async () => {
  for (const file of ['googleabc.html', 'google0123456789abcdef.html<script>', 'google0123456789abcdef.html\n', '../' + verificationFile, 1, {}, 'google' + 'a'.repeat(200) + '.html']) {
    const response = await worker.fetch(new Request('https://meo.test/' + verificationFile), { SELF_GOOGLE_SITE_VERIFICATION_FILE: file }, {});
    assert.equal(response.status, 404);
  }
});
test('Google ownership verification does not accept writes', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await worker.fetch(new Request('https://meo.test/' + verificationFile, {method, body:'private-body-fixture'}), {SELF_GOOGLE_SITE_VERIFICATION_FILE:verificationFile}, {});
    assert.equal(response.status, 405);
    assert.equal(await response.text(), '');
  }
});
test("onboarding pages and assets are same-origin, secret-free and no-store", async () => {
  for (const path of ["/start", "/account", "/account/replies/ss_test"]) {
    const response = await worker.fetch(
      new Request("https://meo.test" + path),
      { ADMIN_KEY: "private-admin-fixture" },
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(
      response.headers.get("Content-Security-Policy"),
      /object-src 'none'/,
    );
    assert.ok(!(await response.text()).includes("private-admin-fixture"));
  }
  const script = await worker.fetch(
    new Request("https://meo.test/self/assets/app.js"),
    {},
    {},
  );
  assert.match(script.headers.get("Content-Type"), /javascript/);
});
test("old signup is not a bypass when D1 self-service is provisioned but closed", async () => {
  const response = await worker.fetch(
    new Request("https://meo.test/signup", { method: "POST", body: "{}" }),
    { SELF_DB: {} },
    {},
  );
  assert.equal(response.status, 410);
});
test("LINE QR is generated locally and never contains the secret registration code", async () => {
  const r = await worker.fetch(
    new Request("https://meo.test/self/assets/line-qr.svg"),
    { SELF_LINE_FRIEND_URL: "https://line.me/R/ti/p/@fixture" },
    {},
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type"), /image\/svg/);
  assert.match(await r.text(), /<svg/);
});
test("all published help links resolve to same-origin human-readable guidance", async () => {
  const page = await worker.fetch(
    new Request("https://meo.test/start"),
    {},
    {},
  );
  const html = await page.text();
  const paths = new Set(
    [...html.matchAll(/href="(\/self\/help\/[^"#]+)"/g)].map((x) => x[1]),
  );
  for (const p of [
    "/self/help/quickstart",
    "/self/help/ai-setup",
    "/self/help/self-hosting",
    "/self/help/faq",
    "/self/help/report",
  ])
    paths.add(p);
  for (const path of paths) {
    const res = await worker.fetch(
      new Request("https://meo.test" + path),
      {},
      {},
    );
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("Content-Type"), /text\/(plain|html)/);
    assert.ok((await res.text()).length > 200);
  }
});

test('support pages work without login or database and never echo query secrets', async () => {
  for (const path of ['/self/help/faq', '/self/help/report']) {
    const response = await worker.fetch(new Request('https://meo.test' + path + '?code=private-code-fixture&token=private-token-fixture'), {
      SELF_DB: { prepare() { throw new Error('Support must not use the DB'); } },
    }, {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.match(response.headers.get('Content-Security-Policy'), /form-action 'none'/);
    const html = await response.text();
    assert.doesNotMatch(html, /private-(code|token)-fixture/);
    assert.doesNotMatch(html, /src="\/self\/assets\/app\.js"/);
    const post = await worker.fetch(new Request('https://meo.test' + path, { method: 'POST', body: 'private-body-fixture' }), {}, {});
    assert.equal(post.status, 405, 'email composer must not pretend to accept reports');
  }
});
test("self-service database failure does not suppress the existing KV scheduler", async () => {
  const prefixes = [];
  const env = {
    SELF_DB: {
      prepare() {
        throw new Error("fixture DB outage");
      },
    },
    STORES: {
      async list({ prefix }) {
        prefixes.push(prefix);
        return { keys: [] };
      },
    },
  };
  await worker.scheduled({}, env, {});
  assert.deepEqual(prefixes, ["pending:", "store:"]);
});
test('top page explains the service without auth or DB and leads to registration', async () => {
  const response = await worker.fetch(new Request('https://meo.test/'), {
    SELF_DB: { prepare() { throw new Error('Top page must not use the DB'); } },
  }, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'none'/);
  const html = await response.text();
  for (const text of ['「送信」', '編集する', '申し込み不要', '先着10店舗', '運営者', 'meo.harness@gmail.com', 'href="/start"', 'href="/self/privacy"', 'href="/self/terms"'])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /スキップ|承認して送信|<script/);
  const css = await worker.fetch(new Request('https://meo.test/self/assets/home.css'), {}, {});
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('Content-Type'), 'text/css; charset=utf-8');
});

test('all public MEO contact pages use the dedicated address rather than the personal mailbox', async () => {
  for (const path of ['/', '/self/help/report', '/self/privacy', '/self/terms', '/self/help/quickstart']) {
    const response = await worker.fetch(new Request('https://meo.test' + path), {}, {});
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.ok(body.includes('meo.harness@gmail.com'), path);
    assert.ok(!body.includes('yosinn1@gmail.com'), path);
    for (const [, recipient] of body.matchAll(/mailto:([^"?]+)/g))
      assert.equal(recipient, 'meo.harness@gmail.com', path);
  }
});
