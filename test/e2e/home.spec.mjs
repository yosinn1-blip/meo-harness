import { test, expect } from '@playwright/test';
import { startTestApp } from '../support/self-browser.mjs';

test.setTimeout(90_000);
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
    expect(requests.some(request => request.method !== 'GET')).toBe(false);
  } finally {
    await context.close();
    await app.stop();
  }
});

// Account for translucent small-print text against its nearest solid background.
async function contrastRatio(locator) {
  return locator.evaluate(element => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const style = getComputedStyle(element);
    let backgroundElement = element;
    let background = rgba(style.backgroundColor);
    let opacity = Number(style.opacity);
    while ((background[3] ?? 1) === 0 && backgroundElement.parentElement) {
      backgroundElement = backgroundElement.parentElement;
      const parentStyle = getComputedStyle(backgroundElement);
      background = rgba(parentStyle.backgroundColor);
      opacity *= Number(parentStyle.opacity);
    }
    const foreground = rgba(style.color);
    const alpha = (foreground[3] ?? 1) * opacity;
    const renderedForeground = foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
    const luminance = rgb => rgb.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const colors = [luminance(renderedForeground), luminance(background)].sort((a, b) => b - a);
    return (colors[0] + 0.05) / (colors[1] + 0.05);
  });
}
async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function expectFocusIndicator(locator) {
  await expect(locator).toBeFocused();
  expect(await locator.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  const outline = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  expect(outline.color).not.toBe('rgba(0, 0, 0, 0)');
}

for (const width of [320, 375, 768, 1280]) {
  test(`home is readable, navigable and disclosure-based at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(app.baseURL + '/');
    // Capture the unmodified page before RED assertions, never over the after evidence.
    if (process.env.HOME_BASELINE === '1')
      await page.screenshot({ path: `output/self-service/home-before-${width}.png`, fullPage: true });
    await expectNoOverflow(page);
    const hero = page.locator('.hero');
    await expect(hero.locator('a[href="/account"]')).toBeVisible();
    await expect(hero.locator('figure figcaption')).toContainText('画面はイメージです');
    for (const locator of await page.locator('a[href="/start"], .btn-primary small, .card-head, .chip-send').all()) {
      await expect(locator).toBeVisible();
      expect(await contrastRatio(locator), await locator.innerText()).toBeGreaterThanOrEqual(4.5);
    }
    const pricingEntry = page.locator('a[href="#pricing"]:visible').first();
    await expect(pricingEntry).toBeVisible();
    await pricingEntry.click();
    const pricing = page.locator('#pricing');
    await expect(pricing).toBeVisible();
    await expect.poll(() => pricing.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(
      await page.locator('header').evaluate(element => Math.ceil(element.getBoundingClientRect().bottom)) - 1,
    );
    const pricingContent = await pricing.innerText();
    expect(pricingContent).toContain('先着10店舗');
    expect(pricingContent).toContain('月30件');
    const disclosures = page.locator('#faq details');
    await expect(disclosures).toHaveCount(3);
    for (const disclosure of await disclosures.all()) {
      const summary = disclosure.locator('summary');
      await summary.click();
      await expect(disclosure).toHaveAttribute('open', '');
      await expectNoOverflow(page);
      await summary.click();
      await expect(disclosure).not.toHaveAttribute('open', '');
    }
    for (const summary of await page.locator('#faq summary').all()) await summary.click();
    await page.locator('#faq').screenshot({ path: `output/self-service/home-faq-${width}.png` });
    for (const summary of await page.locator('#faq summary').all()) await summary.click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `output/self-service/home-improved-${width}.png`, fullPage: true });
    // Use page coordinates: element screenshots scroll a tall hero under the sticky header.
    await page.evaluate(() => scrollTo(0, 0));
    const heroClip = await hero.boundingBox();
    await page.screenshot({ path: `output/self-service/home-hero-${width}.png`, fullPage: true, clip: heroClip });
    expect(requests.some(request => request.path.startsWith('/api/self/'))).toBe(false);
  });
}

test('home keyboard navigation exposes skip, CTA and native FAQ focus', async ({ page }) => {
  await page.goto(app.baseURL + '/');
  const skip = page.getByRole('link', { name: '本文へ移動', exact: true });
  await page.keyboard.press('Tab');
  await expect(skip).toBeVisible();
  await expectFocusIndicator(skip);
  await page.keyboard.press('Enter');
  const main = page.locator('main#main-content');
  await expect(main).toHaveAttribute('tabindex', '-1');
  await expect(main).toBeFocused();
  await page.keyboard.press('Tab');
  await expectFocusIndicator(page.locator('.hero a[href="/start"]'));
  const summary = page.locator('#faq summary').first();
  await summary.focus();
  await expectFocusIndicator(summary);
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(summary.locator('..')).not.toHaveAttribute('open', '');
});

test('home works without JavaScript and exposes support, pricing and existing-account links', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, viewport: { width: 375, height: 812 } });
  try {
    await restrictNetwork(context);
    const page = await context.newPage();
    await page.goto(app.baseURL + '/');
    await expect(page.locator('script')).toHaveCount(0);
    await expect(page.locator('.hero a[href="/account"]')).toBeVisible();
    await page.locator('a[href="#pricing"]:visible').first().click();
    await expect(page).toHaveURL(app.baseURL + '/#pricing');
    for (const disclosure of await page.locator('#faq details').all()) {
      await disclosure.locator('summary').click();
      await expect(disclosure).toHaveAttribute('open', '');
    }
    await expect(page.locator('#faq details[open]')).toHaveCount(3);
    await expectNoOverflow(page);
    await page.screenshot({ path: 'output/self-service/home-no-js-mobile.png', fullPage: true });
    for (const [path, heading] of [['/self/help/faq', 'よくある質問'], ['/self/help/report', '問題を報告・相談する']]) {
      await page.goto(app.baseURL + '/');
      await page.locator(`a[href="${path}"]:visible`).first().click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    expect(requests.some(request => request.path.startsWith('/api/self/'))).toBe(false);
  } finally { await context.close(); }
});

test('home CTA reaches the registration screen using only a local challenge fixture', async ({ page }) => {
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', route => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.turnstile={render:(el,options)=>{options.callback("fixture-challenge");return "fixture-widget";}};',
  }));
  await page.goto(app.baseURL + '/');
  await page.locator('.hero a[href="/start"]').click();
  await expect(page).toHaveURL(app.baseURL + '/start');
  await expect(page.getByRole('button', { name: 'Googleで接続', exact: true })).toBeVisible();
  expect(requests.some(request => /\/api\/self\/(?:google|line)/.test(request.path))).toBe(false);
});
