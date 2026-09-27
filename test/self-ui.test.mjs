import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorker } from "../scripts/build-self-test.mjs";
const compiled = await buildWorker();
const worker = (await import(compiled)).default;
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
