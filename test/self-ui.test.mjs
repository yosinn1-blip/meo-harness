import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorker } from "../scripts/build-self-test.mjs";
import { buildReviewBubble, SEND_DISPLAY_TEXT } from "../src/line-flex.mjs";
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
  for (const path of ['/self/help/faq', '/self/help/report', '/self/help/quickstart']) {
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
  for (const text of ['「送信」', '編集する', '先着10店舗', '月30件', '運営者', 'meo.harness@gmail.com', 'href="/start"', 'href="/self/privacy"', 'href="/self/terms"'])
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

test('home exposes pricing, support and existing-account entry without setup-time guarantees', async () => {
  const response = await worker.fetch(new Request('https://meo.test/'), {}, {});
  const html = await response.text();
  for (const fragment of ['href="#pricing"', 'id="pricing"', 'id="faq"', 'href="/self/help/faq"', 'href="/self/help/report"'])
    assert.ok(html.includes(fragment), fragment);
  const hero = html.match(/<section[^>]*class="hero"[\s\S]*?<\/section>/)?.[0];
  assert.ok(hero, 'hero section exists');
  assert.match(hero, /href="\/account"/);
  assert.doesNotMatch(html, /5分で完了|5分で始められ|待ち時間もありません/);
});

test('home FAQ uses native disclosures for accounts, manual sending and daily notification timing', async () => {
  const response = await worker.fetch(new Request('https://meo.test/'), {}, {});
  const html = await response.text();
  const faq = html.match(/<section[^>]*id="faq"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(faq, 'FAQ section exists');
  const disclosures = [...faq.matchAll(/<details(?:\s[^>]*)?>[\s\S]*?<\/details>/g)].map(match => match[0]);
  assert.equal(disclosures.length, 5);
  for (const disclosure of disclosures) assert.match(disclosure, /<summary(?:\s[^>]*)?>[\s\S]+?<\/summary>/);
  assert.match(faq, /Google(?:アカウント|ビジネスプロフィール)/);
  assert.match(faq, /LINE/);
  assert.match(faq, /送信/);
  assert.match(faq, /1日1回/);
  assert.match(faq, /朝9時以降/);
});

test('home supplies a keyboard skip destination and labels the illustrative review example', async () => {
  const response = await worker.fetch(new Request('https://meo.test/'), {}, {});
  const html = await response.text();
  assert.match(html, /<a[^>]*href="#main-content"[^>]*>本文へ移動<\/a>/);
  const main = html.match(/<main\b[^>]*>/)?.[0];
  assert.match(main ?? '', /id="main-content"/);
  assert.match(main ?? '', /tabindex="-1"/);
  const figure = html.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/)?.[0];
  assert.ok(figure, 'illustrative review belongs to a figure');
  assert.match(figure, /<figcaption(?:\s[^>]*)?>[\s\S]*画面はイメージです[\s\S]*<\/figcaption>/);
  assert.match(figure, /架空/);
});

async function homeHtml() {
  const response = await worker.fetch(new Request('https://meo.test/'), {}, {});
  return response.text();
}
const homeSection = (html, id) => html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? '';

test('home steps quote the printed button names of the production one-button LINE flow', async () => {
  const html = await homeHtml();
  const steps = homeSection(html, 'steps');
  assert.ok(steps, 'steps section exists');
  for (const name of ['初めての方：Googleでお店を接続', 'この店舗を使う', 'LINEを開いてコードを送る', '確認して登録画面へ進む', '通知先を確認して次へ', '利用を開始する'])
    assert.ok(steps.includes(`「${name}」`), name);
  assert.doesNotMatch(steps, /「Googleで接続」|6桁|LINEで本人確認/);
  assert.ok(steps.includes('返信案は登録直後には届きません。'));
  assert.equal(html.split('登録直後には届きません').length - 1, 1, 'stated once');
  assert.match(steps, /スマホ1台/);
  assert.doesNotMatch(html, /次の朝9時|昼以降|\d+分ほど|\d+分で/);
});

test('home preview card mirrors the real LINE review card wording', async () => {
  const html = await homeHtml();
  const figure = html.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/)?.[0] ?? '';
  const bubble = buildReviewBubble({ replyId: 'r1', review: { star: 5, name: '山田様', text: '例', draft: '例' }, bizName: 'Yoshiki Cafe', editable: true });
  const head = bubble.header.contents[0].text;
  const texts = bubble.body.contents.flatMap(box => box.contents ?? []).map(item => item.text);
  const notice = texts.find(text => /7日/.test(text ?? ''));
  assert.ok(notice, 'real card has the 7-day notice');
  assert.ok(figure.includes(`<div class="card-head">${head}</div>`), head);
  assert.ok(figure.includes(`<p class="fine">${notice}</p>`), notice);
  assert.ok(figure.includes('<p class="label">返信案</p>'));
  assert.match(figure, /<p class="review">「[^<]+」<\/p>/);
  assert.doesNotMatch(figure, /AIの返信案|Googleへの投稿を確認しました/);
  // LINE shows the postback displayText as the owner's bubble, so the preview mirrors it.
  assert.ok(figure.includes(`<p class="bubble-me">${SEND_DISPLAY_TEXT}</p>`), SEND_DISPLAY_TEXT);
  assert.ok(figure.includes('返信がGoogleに投稿されたことを確認しました。'));
  const actions = figure.match(/<div class="card-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(actions, /chip-send">送信<\/span>[\s\S]*chip-edit">編集する<\/span>/);
});

test('home explains editing, AI data handling, limits, eligibility and the unofficial status', async () => {
  const html = await homeHtml();
  assert.ok(!html.includes('LINEで送るだけ'));
  assert.ok(html.includes('直した内容の確認カードが届くので、よければ「送信」を押します。'));
  assert.ok(html.includes('Groq'));
  assert.ok(html.includes('href="/self/privacy"'));
  assert.ok(homeSection(html, 'pricing').includes('直近60日'));
  assert.ok(html.includes('公式サービスではありません'));
  assert.ok(html.includes('個人店向け'));
  assert.ok(homeSection(html, 'steps').includes('オーナーや本部が管理しているお店は'));
  const faq = homeSection(html, 'faq');
  assert.ok(faq.includes('コードを送ったLINEに届きます'));
  assert.ok(faq.includes('試験運用'));
  const summaries = [...faq.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(match => match[1]);
  assert.equal(summaries.length, 5);
  assert.equal(new Set(summaries).size, summaries.length, 'FAQ questions are distinct');
});

test('draft scope and the five-per-notification batch are never described as a first-time draft cap', async () => {
  // Production: every unreplied review from the last 60 days is drafted, one per
  // scheduled run up to the monthly cap; only a LINE notification holds at most 5.
  const { readFileSync } = await import('node:fs');
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  assert.match(read('worker/self-service/scheduled.mjs'), /processSelfJobs\(ctx, \{ limit: 1 \}\)/);
  assert.match(read('worker/self-service/notifications.mjs'), /ORDER BY j\.created_at,r\.id LIMIT 5"/);
  assert.match(read('worker/self-service/contracts.mjs'), /firstPollDays: 60,/);
  const quickstart = await (await worker.fetch(new Request('https://meo.test/self/help/quickstart'), {}, {})).text();
  const pages = {
    registration: read('worker/self-service/ui/app.js.txt'),
    homePricing: homeSection(await homeHtml(), 'pricing'),
    quickstart,
    quickstartDoc: read('docs/quickstart.md'),
  };
  for (const [name, text] of Object.entries(pages)) {
    assert.ok(text.includes('対象は直近60日以内で、まだ返信していない口コミです'), name + ': draft scope');
    assert.match(text, /最大5件ずつLINE(?:に|へ)届きます/, name + ': notification batch');
    assert.ok(text.includes('登録直後には届'), name + ': not right after registration');
    assert.doesNotMatch(text, /(?:初回|最初)[^。<]*5件|5件まで/, name + ': no first-time five-draft cap');
  }
});

test('quickstart is a mobile HTML guide that uses the printed button names', async () => {
  const response = await worker.fetch(new Request('https://meo.test/self/help/quickstart'), {}, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const html = await response.text();
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1" \/>/);
  assert.doesNotMatch(html, /<script/);
  for (const text of ['初めての方：Googleでお店を接続', 'この店舗を使う', 'LINEを開いてコードを送る', '利用を開始する', '「送信」', '「編集する」', '確認して登録画面へ進む', '通知先を確認して次へ'])
    assert.ok(html.includes(text), text);
  for (const text of ['1 このLINEで確認', 'ローカル', '未公開', 'D1', 'スキップ', '承認して送信'])
    assert.ok(!html.includes(text), text);
  const aiSetup = await worker.fetch(new Request('https://meo.test/self/help/ai-setup'), {}, {});
  assert.equal(aiSetup.headers.get('Content-Type'), 'text/plain; charset=utf-8');
});

test('FAQ keeps stable, unique anchors for linked questions', async () => {
  const html = await (await worker.fetch(new Request('https://meo.test/self/help/faq'), {}, {})).text();
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of ['replies', 'not-posted', 'expired'])
    assert.equal(ids.filter(x => x === id).length, 1, id);
  const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1]).join('\n');
  assert.doesNotMatch(summaries, /承認したのに|承認ボタンの期限/);
});
