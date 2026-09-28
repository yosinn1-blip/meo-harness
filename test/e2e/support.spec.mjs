import { test, expect } from '@playwright/test';
import { startTestApp } from '../support/self-browser.mjs';

let app, requests, unexpected;
async function restrictNetwork(context) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method() });
    if (url.origin === app.baseURL) return route.continue();
    unexpected.push(url.origin);
    return route.abort('blockedbyclient');
  });
}
test.beforeEach(async ({ context }) => {
  app = await startTestApp();
  requests = [];
  unexpected = [];
  await restrictNetwork(context);
});
test.afterEach(async ({ context }) => {
  try {
    expect(unexpected).toEqual([]);
    expect(app.unexpected).toEqual([]);
    expect(app.pushes).toEqual([]);
    expect(app.writes).toEqual([]);
  } finally {
    await context.close();
    await app.stop();
  }
});

test('public FAQ gives concrete recovery steps and routes to the report form without login', async ({ page }) => {
  await page.goto(app.baseURL + '/self/help/faq');
  await expect(page.getByRole('heading', { name: 'よくある質問', exact: true })).toBeVisible();
  await page.getByText('Googleでログインできません', { exact: true }).click();
  await expect(page.getByText('パスワードや認証コードを運営者へ送る必要はありません。', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'output/self-service/support-faq-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '問題を報告・相談する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '問題を報告・相談する', exact: true })).toBeVisible();
  expect(requests.some(r => r.path.startsWith('/api/self/'))).toBe(false);
});

async function fillReport(page, { consent = true, submit = true } = {}) {
  await page.getByLabel('相談する内容').selectOption('line');
  await page.getByLabel('お店の名前（任意）').fill('架空サロン & 花');
  await page.getByLabel('発生した日時（任意）').fill('2026-09-27T10:30');
  await page.getByLabel('どの画面ですか').selectOption('account');
  await page.getByLabel('行った操作').fill('確認番号をLINEに送るボタンを押しました。');
  await page.getByLabel('起きたこと・相談したいこと').fill('番号が届きません。<script>alert("fixture")</script> &bcc=other@example.test');
  await page.getByLabel('端末・ブラウザ（任意）').fill('iPhone / Safari');
  if (consent) await page.getByLabel('パスワード・認証コード・お客様の個人情報を含めていないことを確認しました').check();
  if (submit) await page.getByRole('button', { name: 'メール内容を確認する', exact: true }).click();
}

test('report builds a reviewed mail draft, not a network submission; editing invalidates the old draft', async ({ page }) => {
  await page.goto(app.baseURL + '/self/help/report?code=private-code-fixture&token=private-token-fixture');
  await fillReport(page);
  const preview = page.getByLabel('メール本文');
  await expect(preview).toHaveValue(/架空サロン & 花/);
  await expect(preview).toHaveValue(/<script>alert\("fixture"\)<\/script>/);
  await expect(page.getByText('まだ送信されていません。', { exact: false })).toBeVisible();
  const url = new URL(await page.getByRole('link', { name: 'メールアプリを開く', exact: true }).getAttribute('href'));
  expect(url.protocol).toBe('mailto:');
  expect(url.pathname).toBe('meo.harness@gmail.com');
  expect([...url.searchParams.keys()]).toEqual(['subject', 'body']);
  expect(url.searchParams.get('body')).toContain('2026-09-27 10:30');
  expect(url.searchParams.get('body')).not.toMatch(/private-(code|token)-fixture/);
  expect(requests.some(r => r.method !== 'GET')).toBe(false);
  expect(requests.some(r => r.path.startsWith('/api/self/'))).toBe(false);
  await page.getByLabel('起きたこと・相談したいこと').fill('編集しました');
  await expect(page.getByRole('link', { name: 'メールアプリを開く', exact: true })).toBeHidden();
  await expect(preview).toBeHidden();
});

test('mobile report requires input and consent; clipboard failure leaves selectable text and no false success', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('fixture denied'); } } }));
  await page.goto(app.baseURL + '/self/help/report');
  await expect(page.getByLabel('行った操作')).toHaveCSS('padding-left', '12px');
  await page.getByRole('button', { name: 'メール内容を確認する', exact: true }).click();
  await expect(page.getByRole('link', { name: 'メールアプリを開く', exact: true })).toBeHidden();
  await fillReport(page);
  await page.getByRole('button', { name: '本文をコピーする', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('自動コピーできませんでした');
  await expect(page.getByRole('status')).not.toContainText('コピーしました');
  const input = page.getByLabel('メール本文');
  expect(await input.evaluate(el => el.selectionEnd - el.selectionStart)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/self-service/support-report-mobile.png', fullPage: true });
});

test('start and account footer links lead to public support on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // Only the existing registration screen uses Turnstile; do not call the live service.
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', route => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.turnstile={render:(el,options)=>{options.callback("fixture-challenge");return "fixture-widget";}};',
  }));
  for (const entry of ['/start', '/account']) {
    await page.goto(app.baseURL + entry);
    await page.getByRole('link', { name: 'よくある質問', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'よくある質問', exact: true })).toBeVisible();
    await page.goto(app.baseURL + entry);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: '問題を報告・相談する', exact: true }).click();
    await expect(page.getByRole('heading', { name: '問題を報告・相談する', exact: true })).toBeVisible();
  }
});

test('without JavaScript report entry stays disabled and direct mail guidance remains available', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  try {
    await restrictNetwork(context);
    const page = await context.newPage();
    await page.goto(app.baseURL + '/self/help/report');
    await expect(page.getByRole('button', { name: 'メール内容を確認する', exact: true })).toBeDisabled();
    await expect(page.getByText('入力フォームが利用できない場合は', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'meo.harness@gmail.com', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('a script loading failure leaves safe direct contact guidance instead of a working-looking form', async ({ page }) => {
  await page.route('**/self/assets/report.js', route => route.abort('failed'));
  await page.goto(app.baseURL + '/self/help/report');
  await expect(page.getByRole('button', { name: 'メール内容を確認する', exact: true })).toBeDisabled();
  await expect(page.getByText('入力フォームが利用できない場合は', { exact: false })).toBeVisible();
  expect(requests.some(r => r.method !== 'GET')).toBe(false);
});

test('a report requires consent and nonblank details and recovers after correction', async ({ page }) => {
  await page.goto(app.baseURL + '/self/help/report');
  await fillReport(page, { consent: false });
  const mail = page.getByRole('link', { name: 'メールアプリを開く', exact: true });
  await expect(mail).toBeHidden();
  await page.getByLabel('パスワード・認証コード・お客様の個人情報を含めていないことを確認しました').check();
  await page.getByLabel('行った操作').fill('   ');
  await page.getByRole('button', { name: 'メール内容を確認する', exact: true }).click();
  await expect(mail).toBeHidden();
  await page.getByLabel('行った操作').fill('アカウントを開いた');
  await page.getByRole('button', { name: 'メール内容を確認する', exact: true }).click();
  await expect(mail).toBeVisible();
});

test('copy success never claims receipt and pending copy feedback cannot revive an edited preview', async ({ page }) => {
  await page.addInitScript(() => {
    window.copiedReports = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: body => new Promise(resolve => {
      window.copiedReports.push(body);
      window.finishCopy = resolve;
    }) } });
  });
  await page.goto(app.baseURL + '/self/help/report');
  await fillReport(page);
  await page.getByRole('button', { name: '本文をコピーする', exact: true }).click();
  await page.evaluate(() => window.finishCopy());
  await expect(page.getByRole('status')).toContainText('本文をコピーしました');
  await expect(page.getByRole('status')).toContainText('まだ送信はしていません');
  expect(await page.evaluate(() => window.copiedReports[0])).toBe(await page.getByLabel('メール本文').inputValue());
  await page.getByRole('button', { name: '本文をコピーする', exact: true }).click();
  await page.getByLabel('行った操作').fill('編集後の操作');
  await page.getByRole('button', { name: 'メール内容を確認する', exact: true }).click();
  await page.evaluate(() => window.finishCopy());
  await expect(page.getByRole('status')).toBeEmpty();
});

test('home and policy contact links show the dedicated mailbox on desktop and mobile', async ({ page }) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/self/privacy', '/self/terms']) {
      await page.goto(app.baseURL + path);
      const contact = page.getByRole('link', { name: 'meo.harness@gmail.com', exact: true });
      await expect(contact).toBeVisible();
      await expect(contact).toHaveAttribute('href', 'mailto:meo.harness@gmail.com');
      await expect(page.getByText('yosinn1@gmail.com', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === '/') await contact.locator('..').screenshot({ path: `output/self-service/contact-${width}.png` });
    }
  }
});
