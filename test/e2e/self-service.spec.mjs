import { test, expect } from "@playwright/test";
import { startTestApp } from "../support/self-browser.mjs";
let app, unexpected;
test.beforeEach(async ({ context }) => {
  app = await startTestApp();
  unexpected = [];
  await context.setExtraHTTPHeaders({ "X-Fixture-Key": app.fixtureKey });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === "challenges.cloudflare.com" &&
      url.pathname === "/turnstile/v0/api.js"
    )
      return route.fulfill({
        contentType: "text/javascript",
        body: 'window.turnstile={render:(el,options)=>{options.callback("fixture-challenge");return "fixture-widget";}};',
      });
    if (url.origin === app.baseURL) return route.continue();
    unexpected.push(url.origin);
    return route.abort("blockedbyclient");
  });
});
test.afterEach(async ({ context }) => {
  try {
    expect(unexpected).toEqual([]);
    expect(app.unexpected).toEqual([]);
  } finally {
    await context.close();
    await app.stop();
  }
});
const activeTiming = "返信案ができたときだけ、原則1日1回、朝9時以降にまとめてLINEへお知らせします。登録直後には届きません。利用枠や処理の状況で、届かない日もあります。";
const challengeFailed = "ロボットでないことの自動チェックをやり直しています。画面上のチェックが終わってから、もう一度ボタンを押してください。";
async function fixture(page, path, body = {}) {
  if(path==='cron' && !body.phase){
    const poll=await fixture(page,path,{...body,phase:'poll'});
    expect(poll.ok(),await poll.text()).toBe(true);
    return fixture(page,path,{...body,phase:'notify'});
  }
  return page.request.post(app.baseURL + "/fixture/" + path, {
    data: body,
    headers: { "X-Fixture-Key": app.fixtureKey },
  });
}
async function sendPin(page) {
  const [r] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/self/line/test")),
    page.getByRole("button", { name: "確認番号をLINEに送る" }).click(),
  ]);
  expect(r.status(), await r.text()).toBe(200);
  await expect(page.getByText("LINEに確認番号を送りました")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "確認する", exact: true }),
  ).toBeEnabled();
}
async function connect(page) {
  await page.goto(app.baseURL + "/start");
  await page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true }).click();
  await page.getByRole("button", { name: "架空Googleで許可" }).click();
}
async function oneReturnScreens(page,stage) {
  for(const [width,name] of [[320,"mobile320"],[375,"mobile"],[1280,"desktop"]]){
    await page.setViewportSize({width,height:812});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`output/self-service/one-return-${name}-${stage}.png`,fullPage:true});
  }
  await page.setViewportSize({width:375,height:812});
}
async function onboard(page) {
  await connect(page);
  await page
    .getByRole("button", { name: "この店舗を使う", exact: true })
    .first()
    .click();
  const code = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", { code, userId: "line-fixture" });
  await page.getByRole("button", { name: "状態を更新" }).click();
  await sendPin(page);
  const pin = (await (await fixture(page, "pin")).json()).pin;
  await page.getByLabel("確認番号", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("link", { name: "利用条件（別タブ）" })).toHaveAttribute("href", "/self/terms");
  await expect(page.getByRole("link", { name: "プライバシー（別タブ）" })).toHaveAttribute("href", "/self/privacy");
  await page.getByLabel("利用条件を確認しました").check();
  await page.getByRole("button", { name: "利用を開始する" }).click();
  await expect(
    page.getByRole("heading", { name: "稼働中", exact: true }),
  ).toBeVisible();
}
test("PC initial registration, empty reviews, pause/resume and disconnect without admin or Google writes", async ({
  page,
}) => {
  const admin = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/admin/")) admin.push(r.url());
  });
  await onboard(page);
  await page.screenshot({
    path: "output/self-service/desktop-active.png",
    fullPage: true,
  });
  await expect(page.getByText("登録が完了しました。", { exact: true })).toBeVisible();
  await expect(page.getByText(activeTiming, { exact: true })).toBeVisible();
  await expect(page.getByText("架空の口コミ", { exact: false })).toHaveCount(0);
  await fixture(page, "cron");
  await page.getByRole("button", { name: "状態を更新", exact: true }).click();
  await expect(
    page.getByText("未返信の新しい口コミはありません。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "利用を停止", exact: true }).click();
  await page.getByRole("button", { name: "停止する", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "停止中", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(activeTiming, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "利用を再開" }).click();
  await expect(
    page.getByRole("heading", { name: "稼働中", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "接続を切断" }).click();
  await page.getByRole("button", { name: "切断してデータを削除" }).click();
  await expect(
    page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true }),
  ).toBeVisible();
  expect(admin).toEqual([]);
  expect(app.writes).toEqual([]);
});
test("public policies are readable before login on mobile and return to registration", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(app.baseURL + "/start");
  await page.getByRole("link", { name: "プライバシー", exact: true }).click();
  await expect(page.getByRole("heading", { name: "プライバシー・データの取り扱い", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "output/self-service/mobile-privacy.png", fullPage: true });
  await page.getByRole("link", { name: "利用条件", exact: true }).click();
  await expect(page.getByRole("heading", { name: "共有サービス版の利用条件", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "output/self-service/mobile-terms.png", fullPage: true });
  await page.getByRole("link", { name: "登録画面へ", exact: true }).click();
  await expect(page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true })).toBeVisible();
  expect(app.writes).toEqual([]);
});
test("mobile registration survives refresh, never overflows and keyboard focus is visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "この店舗を使う" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "状態を更新", exact: true })).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await page.screenshot({
    path: "output/self-service/mobile-selection.png",
    fullPage: true,
  });
});
test("zero locations and provider error show different recovery instructions", async ({
  page,
}) => {
  await fixture(page, "scenario", { locations: 0 });
  await connect(page);
  await expect(
    page.getByText("管理できる店舗が見つかりませんでした。", { exact: false }),
  ).toBeVisible();
  await fixture(page, "scenario", { locations: 1, googleFailure: true });
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "別のGoogleアカウントで入り直す", exact: true })).toHaveCount(0);
});
test("zero locations lets the owner start over with another Google account and only then shows the account chooser", async ({
  page,
}) => {
  await fixture(page, "scenario", { locations: 0 });
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page);
  await expect(
    page.getByText("管理できる店舗が見つかりませんでした。", { exact: false }),
  ).toBeVisible();
  const again = page.getByRole("button", { name: "別のGoogleアカウントで入り直す", exact: true });
  await expect(again).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "output/self-service/zero-locations-375.png", fullPage: true });
  const [out] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/self/logout")),
    again.click(),
  ]);
  expect(out.ok()).toBe(true);
  const first = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  await expect(first).toBeVisible();
  expect((await (await page.request.get(app.baseURL + "/api/self/status")).json()).state).toBe("anonymous");
  const [start] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/api/self/google/start")),
    first.click(),
  ]);
  expect(start.postDataJSON()).toMatchObject({ intent: "connect", switchAccount: true });
  await expect(page.getByRole("heading", { name: "架空Google認可画面" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("prompt")).toBe("select_account consent");
  expect(await page.evaluate(() => sessionStorage.getItem("meo-account-switch"))).toBeNull();
  expect(app.writes).toEqual([]);
});
test("denied Google authorization returns without secrets in URL", async ({
  page,
}) => {
  await page.goto(app.baseURL + "/start");
  await page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true }).click();
  await page.getByRole("button", { name: "許可しない", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("権限が許可されません");
  expect(page.url()).toBe(app.baseURL + "/account");
});
test("expired Turnstile tokens disable Google connection until a fresh check", async ({ page, context }) => {
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?**", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.turnstile={render:(el,o)=>{const b=document.createElement('button');b.textContent='Expire fixture challenge';b.onclick=()=>o['expired-callback']();el.append(b);o.callback('fixture-challenge');return 'fixture-widget';}};`,
  }));
  await page.goto(app.baseURL + "/start");
  const connectButton = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  await expect(connectButton).toBeEnabled();
  await page.getByRole("button", { name: "Expire fixture challenge" }).click();
  await expect(connectButton).toBeDisabled();
  await expect(page.locator("#challenge-status")).toHaveText("確認をやり直しています。少しお待ちください。");
});
test("a slow robot check explains the disabled buttons above the card and clears once it completes", async ({ page, context }) => {
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?**", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.turnstile={render:(el,o)=>{window.fixtureChallengeCallback=o.callback;return 'fixture-widget';}};`,
  }));
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(app.baseURL + "/start");
  const connectButton = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  const status = page.locator("#challenge-status");
  await expect(connectButton).toBeDisabled();
  await expect(status).toHaveText("確認中です。数秒で押せるようになります。チェック欄が出たときは、それを押してください。");
  const order = await page.evaluate(() => {
    const c = document.querySelector("#challenge"), s = document.querySelector("#current-step"), t = document.querySelector("#challenge-status");
    return {
      before: Boolean(c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(t.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING),
      above: c.getBoundingClientRect().top <= s.getBoundingClientRect().top && t.getBoundingClientRect().bottom <= s.getBoundingClientRect().top,
    };
  });
  expect(order).toEqual({ before: true, above: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "状態を更新" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "始める前に", exact: true })).toBeVisible();
  await page.screenshot({ path: "output/self-service/challenge-wait-320.png", fullPage: true });
  await page.evaluate(() => window.fixtureChallengeCallback("fixture-challenge"));
  await expect(status).toBeHidden();
  await expect(connectButton).toBeEnabled();
});
test("narrow screens keep step labels within two lines, show the publishing assurance and large tap targets", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(app.baseURL + "/start");
  await expect(page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true })).toBeEnabled();
  // Count rendered text lines per step label (font metrics vary, so do not rely on pixel height).
  const lines = await page.locator("#steps li").evaluateAll((items) => items.map((li) => {
    const range = document.createRange();
    range.selectNodeContents(li);
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
  }));
  expect(lines).toHaveLength(4);
  for (const n of lines) expect(n).toBeLessThanOrEqual(2);
  expect(Math.max(...lines)).toBe(2); // the measurement really sees the wrapped labels at 320px
  for (const h of await page.locator("#steps li").evaluateAll((items) => items.map((li) => li.getBoundingClientRect().height)))
    expect(h).toBeLessThan(80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const assurance = page.locator(".assurance");
  await expect(assurance).toBeVisible();
  await expect(assurance).toHaveCSS("font-size", "13px");
  await expect(page.locator(".trial")).toHaveCSS("font-size", "12px");
  await expect(page.locator(".intro > p:not(.assurance)")).toBeHidden();
  for (const box of [
    ...(await page.locator("footer a").evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height))),
    await page.locator(".notes summary").evaluate((s) => s.getBoundingClientRect().height),
  ]) expect(box).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("link", { name: "AIに手伝ってもらう" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "使い方", exact: true })).toHaveAttribute("href", "/self/help/quickstart");
  await page.screenshot({ path: "output/self-service/narrow-start-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".intro > p:not(.assurance)")).toBeVisible();
  await expect(assurance).toBeVisible();
});
test("failed Google start resets the used Turnstile token before retry", async ({ page, context }) => {
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?**", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `let options;window.turnstile={render:(el,o)=>{options=o;o.callback('fixture-challenge-1');return 'fixture-widget';},reset:()=>options.callback('fixture-challenge-2')};`,
  }));
  const tokens = [];
  await page.route("**/api/self/google/start", (route) => {
    tokens.push(route.request().postDataJSON().challenge);
    if (tokens.length === 1) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, code: "CHALLENGE_FAILED" }) });
    return route.continue();
  });
  await page.goto(app.baseURL + "/start");
  const connectButton = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  await connectButton.click();
  await expect(page.getByRole("alert")).toHaveText(challengeFailed);
  await connectButton.click();
  await expect(page.getByRole("button", { name: "架空Googleで許可" })).toBeVisible();
  expect(tokens).toEqual(["fixture-challenge-1", "fixture-challenge-2"]);
});
test("challenge refresh during a pending request cannot enable retry before reset completes", async ({ page, context }) => {
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?**", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.turnstile={render:(el,o)=>{window.fixtureChallengeCallback=o.callback;const b=document.createElement('button');b.textContent='Complete fixture challenge';b.onclick=()=>o.callback('fresh-after-reset');el.append(b);o.callback('fixture-challenge');return 'fixture-widget';},reset:()=>{}};`,
  }));
  await page.route("**/api/self/google/start", async (route) => {
    await page.evaluate(() => window.fixtureChallengeCallback("refreshed-in-flight"));
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, code: "CHALLENGE_FAILED" }) });
  });
  await page.goto(app.baseURL + "/start");
  const connectButton = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  await connectButton.click();
  await expect(page.getByRole("alert")).toHaveText(challengeFailed);
  await expect(connectButton).toBeDisabled();
  await page.getByRole("button", { name: "Complete fixture challenge" }).click();
  await expect(connectButton).toBeEnabled();
});
test("closed intake keeps login and stop available", async ({ page }) => {
  await onboard(page);
  await fixture(page, "scenario", { registration: false });
  await page.reload();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(
    page.getByRole("heading", { name: "新規受付はお休み中です" }),
  ).toBeVisible();
  await expect(page.getByText("パスワードはGoogleの画面にだけ入れます。この画面に入力する欄はありません。", { exact: true })).toHaveCount(1);
  await expect(page.getByText("パスワードはGoogleの画面にだけ入れます。この画面に入力する欄はありません。", { exact: true })).toBeVisible();
  await expect(page.getByText("AIのチャット", { exact: false })).toHaveCount(0);
  await page
    .getByRole("button", { name: "登録済みの方：Googleでログイン", exact: true })
    .click();
  await page.getByRole("button", { name: "架空Googleで許可" }).click();
  await expect(
    page.getByRole("button", { name: "利用を停止", exact: true }),
  ).toBeVisible();
});
test("expired PIN refuses activation and provides resend", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "この店舗を使う" }).click();
  const code = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", { code, userId: "line-fixture" });
  await page.getByRole("button", { name: "状態を更新" }).click();
  await sendPin(page);
  const pin = (await (await fixture(page, "pin")).json()).pin;
  await fixture(page, "advance", { ms: 300000 });
  await page.getByLabel("確認番号", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("有効期限");
  await expect(
    page.getByRole("button", { name: "利用を開始する" }),
  ).toHaveCount(0);
});

function actions(value, found = []) {
  if (value && typeof value === "object") {
    if (value.type === "postback" || value.type === "uri") found.push(value);
    for (const v of Object.values(value)) actions(v, found);
  }
  return found;
}
test("multiple stores, long Japanese review, wrong LINE actor and approval use only fake providers", async ({
  page,
}) => {
  const comment = "とても素敵な髪型になりました。🌸".repeat(90);
  const date = new Date(Date.now() - 3600000).toISOString();
  await fixture(page, "scenario", {
    locations: 2,
    reviews: [
      {
        reviewId: "local-long",
        comment,
        starRating: "FIVE",
        reviewer: { displayName: "架空のお客様" },
        createTime: date,
        updateTime: date,
      },
    ],
  });
  await onboard(page);
  const hour = new Date().getUTCHours();
  if (hour >= 15) await fixture(page, "advance", { ms: 9 * 3600000 });
  // Force a JST daytime clock without advancing beyond the session lifetime.
  await fixture(page, "cron");
  const flex = app.pushes.find((x) => x.messages[0]?.type === "flex");
  expect(flex).toBeTruthy();
  const all = actions(flex);
  const approve = all.find((x) => x.data?.startsWith("approve:"));
  expect(approve).toBeTruthy();
  const full = all.find((x) => x.uri?.includes("/account/replies/"));
  expect(full).toBeTruthy();
  await page.goto(full.uri);
  await expect(
    page.getByRole("heading", { name: "口コミと返信案の全文" }),
  ).toBeVisible();
  await expect(page.locator(".review-full").first()).toHaveText(comment);
  await fixture(page, "postback", {
    action: approve.data,
    userId: "wrong-line",
  });
  expect(app.writes).toEqual([]);
  await fixture(page, "postback", {
    action: approve.data,
    userId: "line-fixture",
  });
  expect(app.writes).toHaveLength(1);
  expect(app.feedback.at(-1)?.messages[0]?.text).toContain(
    "Googleへの投稿を確認しました",
  );
  await page.goto(app.baseURL + "/account");
  await expect(
    page.getByRole("heading", { name: "最近の返信結果" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "始める前に", exact: true })).toBeHidden();
  const faqHelp = page.getByRole("link", { name: "困ったときは（返信案が届かない・Googleに出ない）", exact: true });
  await expect(faqHelp).toBeVisible();
  await expect(faqHelp).toHaveAttribute("href", "/self/help/faq#replies");
  await expect(
    page.getByText("未返信の新しい口コミはありません。", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("投稿を確認しました", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/self-service/desktop-approved.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/self-service/mobile-approved.png",
    fullPage: true,
  });
  await fixture(page, "postback", {
    action: approve.data,
    userId: "line-fixture",
  });
  expect(app.writes).toHaveLength(1);
});
test("LINE shared provider quota exhaustion never sends a confirmation", async ({
  page,
}) => {
  await connect(page);
  await page.getByRole("button", { name: "この店舗を使う" }).click();
  const code = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", { code, userId: "line-fixture" });
  await page.getByRole("button", { name: "状態を更新" }).click();
  await fixture(page, "scenario", { consumed: 200 });
  await page.getByRole("button", { name: "確認番号をLINEに送る" }).click();
  await expect(page.getByRole("alert")).toContainText("利用枠");
  expect(app.pushes).toEqual([]);
});
test("unprocessed reviews at zero draft quota are not described as zero reviews", async ({
  page,
}) => {
  await onboard(page);
  const date = new Date(Date.now() - 3600000).toISOString();
  await fixture(page, "scenario", {
    drafts: 0,
    reviews: [
      {
        reviewId: "backlog",
        comment: "良かったです",
        starRating: "FIVE",
        createTime: date,
        updateTime: date,
      },
    ],
  });
  await fixture(page, "cron");
  await page.getByRole("button", { name: "状態を更新", exact: true }).click();
  await expect(
    page.getByText(
      "処理待ちの口コミ: 1件。利用枠や接続の確認後に順次処理します。",
      { exact: true },
    ),
  ).toBeVisible();
});
test("unfinished Google connection exposes disconnect before store selection", async ({
  page,
}) => {
  await connect(page);
  await page.locator("#setup-account-actions > summary").click();
  await page.getByRole("button", { name: "接続を切断" }).click();
  await page.getByRole("button", { name: "切断してデータを削除" }).click();
  await expect(
    page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true }),
  ).toBeVisible();
});

test("wrong-language draft stays in processing backlog with no approval or Google write", async ({ page }) => {
  await onboard(page);
  const date = new Date(Date.now() - 3600000).toISOString();
  await fixture(page, 'scenario', {
    aiText: 'Thank you for your review.',
    reviews: [{ reviewId: 'quality-held', comment: '良かったです', starRating: 'FIVE', createTime: date, updateTime: date }],
  });
  const pushesBefore = app.pushes.length;
  await fixture(page, 'cron');
  await page.getByRole('button', { name: '状態を更新', exact: true }).click();
  await expect(page.getByText('処理待ちの口コミ: 1件。利用枠や接続の確認後に順次処理します。', { exact: true })).toBeVisible();
  await expect(page.getByText('Thank you for your review.', { exact: true })).toHaveCount(0);
  expect(app.pushes.length).toBe(pushesBefore);
  expect(app.writes).toEqual([]);
  await page.screenshot({ path: 'output/self-service/quality-held.png', fullPage: true });
});


test("owner-only pilot login, Google connect and selection stops without LINE setup", async ({page}) => {
  await fixture(page, "scenario", {pilot:true});
  await page.goto(app.baseURL + "/start");
  await expect(page.getByRole("button", {name:"初めての方：Googleでお店を接続",exact:true})).toHaveCount(0);
  await page.getByRole("button", {name:"登録済みの方：Googleでログイン",exact:true}).click();
  await page.getByRole("button", {name:"架空Googleで許可"}).click();
  await expect(page.getByText("本人限定・1店舗の接続テストです。",{exact:false})).toBeVisible();
  await page.getByRole("button", {name:"Googleでお店を接続",exact:true}).click();
  await page.getByRole("button", {name:"架空Googleで許可"}).click();
  await page.getByRole("button", {name:"この店舗を使う",exact:true}).click();
  await expect(page.getByRole("heading",{name:"お店の接続確認ができました",exact:true})).toBeVisible();
  await expect(page.getByText("AI生成・LINE送信・口コミ公開は停止中です。",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:/LINE|利用を開始|利用を再開/})).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading",{name:"お店の接続確認ができました",exact:true})).toBeVisible();
  await expect(page.locator("#steps li").nth(2)).toBeHidden();
  await expect(page.locator("#steps li").nth(3)).toBeHidden();
  await page.screenshot({path:"output/self-service/owner-pilot-connected.png",fullPage:true});
  await fixture(page,"cron");
  expect((await app.db.prepare("SELECT count(*) n FROM line_links").first()).n).toBe(0);
  expect(app.pushes).toEqual([]); expect(app.writes).toEqual([]); expect(app.feedback).toEqual([]);
});
test("pilot login from another account never offers reconnect or lists locations", async ({page}) => {
  await fixture(page,"scenario",{pilot:true,pilotOwner:"not-alice"});
  await page.goto(app.baseURL+"/start");
  await page.getByRole("button",{name:"登録済みの方：Googleでログイン",exact:true}).click();
  await page.getByRole("button",{name:"架空Googleで許可"}).click();
  await expect(page.getByRole("heading",{name:"新規受付はお休み中です",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/接続|この店舗/})).toHaveCount(1); // Existing disconnect safety action only.
  await expect(page.getByRole("button",{name:/Googleで.*接続|この店舗を使う/})).toHaveCount(0);
});

test("first-time and registered entry choose their respective Google permission intents", async ({ page }) => {
  await page.goto(app.baseURL + "/start");
  const first = page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true });
  const existing = page.getByRole("button", { name: "登録済みの方：Googleでログイン", exact: true });
  await expect(first).toBeEnabled();
  await expect(existing).toBeEnabled();
  await page.screenshot({ path: "output/self-service/onboarding-desktop-start.png", fullPage: true });
  const [connectRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith("/api/self/google/start")),
    first.click(),
  ]);
  expect(connectRequest.postDataJSON().intent).toBe("connect");
  expect(connectRequest.postDataJSON().switchAccount).toBeUndefined();
  await expect(page.getByRole("heading", { name: "架空Google認可画面" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("scope")).toContain("business.manage");
  expect(new URL(page.url()).searchParams.get("prompt")).toBe("consent");
  await page.getByRole("button", { name: "許可しない", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("権限が許可されません");
  await expect(existing).toBeEnabled();
  const [loginRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith("/api/self/google/start")),
    existing.click(),
  ]);
  expect(loginRequest.postDataJSON().intent).toBe("login");
  await expect(page.getByRole("heading", { name: "架空Google認可画面" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("scope")).toBe("openid");
  expect(app.pushes).toEqual([]);
  expect(app.writes).toEqual([]);
});

test("LINE confirmation survives browser back and reload without automatic or duplicate PIN sends", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(app.baseURL + "/start");
  await expect(page.getByRole("button", { name: "初めての方：Googleでお店を接続" })).toBeEnabled();
  await page.screenshot({ path: "output/self-service/onboarding-mobile-start.png", fullPage: true });
  await connect(page);
  await page.getByRole("button", { name: "この店舗を使う" }).click();
  const code = await page.getByTestId("line-code").textContent();
  await page.screenshot({ path: "output/self-service/onboarding-mobile-code.png", fullPage: true });
  // Leave for a same-origin page, then resume the same browser session.
  await page.goto(app.baseURL + "/self/help/quickstart");
  await fixture(page, "line", { code, userId: "line-fixture" });
  await page.goBack();
  const send = page.getByRole("button", { name: "確認番号をLINEに送る", exact: true });
  await expect(send).toBeVisible();
  expect(app.pushes).toEqual([]);
  await page.screenshot({ path: "output/self-service/onboarding-mobile-detected.png", fullPage: true });
  let sends = 0;
  page.on("request", r => { if (r.url().endsWith("/api/self/line/test")) sends++; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route("**/api/self/line/test", async route => { await blocked; await route.continue(); });
  await send.evaluate(b => { b.click(); b.click(); });
  await expect(send).toBeDisabled();
  release();
  await expect(page.getByText("LINEに確認番号を送りました", { exact: false })).toBeVisible();
  expect(sends).toBe(1);
  expect(app.pushes).toHaveLength(1);
  await page.screenshot({ path: "output/self-service/onboarding-mobile-pin-sent.png", fullPage: true });
  const pin = (await (await fixture(page, "pin")).json()).pin;
  await page.reload();
  await expect(page.getByLabel("確認番号", { exact: true })).toBeVisible();
  expect(sends).toBe(1);
  expect(app.pushes).toHaveLength(1);
  await page.getByLabel("確認番号", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("button", { name: "利用を開始する" })).toBeVisible();
  await page.getByRole("button", { name: "利用を開始する" }).click();
  await expect(page.getByRole("heading", { name: "準備ができました" })).toBeVisible();
  await expect(page.getByLabel("利用条件を確認しました")).toBeFocused();
  await page.screenshot({ path: "output/self-service/onboarding-mobile-ready.png", fullPage: true });
  expect(app.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("LINE recovery reissues a code and requires confirmation of the new notification owner", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "この店舗を使う" }).click();
  const originalCode = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", { code: originalCode, userId: "line-fixture" });
  await page.getByRole("button", { name: "状態を更新" }).click();
  await sendPin(page);
  const oldPin = (await (await fixture(page, "pin")).json()).pin;
  await page.getByText("通知先のLINEを変更する・登録コードを送り直す", { exact: true }).click();
  await page.getByRole("button", { name: "コードを再発行", exact: true }).click();
  const newCode = await page.getByTestId("line-code").textContent();
  expect(newCode).not.toBe(originalCode);
  expect(app.pushes).toHaveLength(1);
  await fixture(page, "line", { code: newCode, userId: "line-other" });
  await page.getByRole("button", { name: "状態を更新" }).click();
  await page.getByLabel("確認番号", { exact: true }).fill(oldPin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("確認番号が違うか");
  await expect(page.getByRole("button", { name: "利用を開始する" })).toHaveCount(0);
  await fixture(page, "advance", { ms: 60001 });
  await sendPin(page);
  const newPin = (await (await fixture(page, "pin")).json()).pin;
  await page.getByLabel("確認番号", { exact: true }).fill(newPin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "準備ができました" })).toBeVisible();
  expect(app.pushes.map(push => push.to)).toEqual(["line-fixture", "line-other"]);
  expect(app.writes).toEqual([]);
});

test("automatic PIN arrives in the single LINE visit and reload/back never sends another one", async ({ page }) => {
  await fixture(page,"scenario",{autoPin:true});
  await page.setViewportSize({width:375,height:812});
  let manual=0;page.on("request",r=>{if(r.url().endsWith("/api/self/line/test"))manual++;});
  await connect(page);await page.getByRole("button",{name:"この店舗を使う"}).click();
  const code=await page.getByTestId("line-code").textContent();
  await oneReturnScreens(page,"code");
  const [line]=await Promise.all([page.waitForEvent("popup"),page.getByRole("link",{name:"LINEで友だち追加",exact:true}).click()]);
  await line.setViewportSize({width:375,height:812});
  await line.getByLabel("登録コード",{exact:true}).fill(code);
  await line.getByRole("button",{name:"LINEへコード送信（架空）"}).click();
  await expect(line.locator("#received")).toContainText("確認番号:");
  const pin=(await line.locator("#received").textContent()).match(/\d{6}/)[0];
  await line.screenshot({path:"output/self-service/one-return-mock-line-pin.png",fullPage:true});
  await line.close();await page.bringToFront();
  expect(app.pushes).toHaveLength(1);
  await expect(page.getByLabel("確認番号",{exact:true})).toBeVisible();
  await page.goto(app.baseURL+"/self/help/quickstart");
  await page.goBack();await expect(page.getByLabel("確認番号",{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel("確認番号",{exact:true})).toBeVisible();
  expect(app.pushes).toHaveLength(1);expect(manual).toBe(0);
  const status=await(await page.request.get(app.baseURL+"/api/self/status")).json();
  expect(status.lineCheck.state).toBe("sent");expect(status.lineCheck.pinAvailable).toBe(true);
  expect(status.lineCheck).not.toHaveProperty("pin");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await oneReturnScreens(page,"confirm");
  await page.getByLabel("確認番号",{exact:true}).fill(pin);
  await page.getByRole("button",{name:"確認する",exact:true}).click();
  await expect(page.getByRole("heading",{name:"準備ができました"})).toBeVisible();
  await page.getByRole("button",{name:"利用を開始する"}).click();
  await expect(page.getByLabel("利用条件を確認しました")).toBeFocused();
  await oneReturnScreens(page,"ready");
  await page.getByLabel("利用条件を確認しました").check();
  await page.getByRole("button",{name:"利用を開始する"}).click();
  await expect(page.getByRole("heading",{name:"稼働中",exact:true})).toBeVisible();
  expect(app.writes).toEqual([]);expect(manual).toBe(0);
});

for(const failure of ["unknown","failed","quota"])test(`automatic PIN ${failure} offers explicit recovery without reload or back resends`,async({page})=>{
  await fixture(page,"scenario",{autoPin:true,lineFailure:failure==="quota"?null:failure,...(failure==="quota"?{consumed:200}:{})});
  await page.setViewportSize({width:375,height:812});
  await connect(page);await page.getByRole("button",{name:"この店舗を使う"}).click();
  const code=await page.getByTestId("line-code").textContent();await fixture(page,"line",{code,userId:"line-fixture"});
  await page.reload();
  const expectedPushes=failure==="quota"?0:1;expect(app.pushes).toHaveLength(expectedPushes);
  if(failure==="quota")await expect(page.getByLabel("確認番号",{exact:true})).toHaveCount(0);
  else {
    await expect(page.getByLabel("確認番号",{exact:true})).toBeVisible();
    await page.getByText("確認番号が届かない・期限が切れたとき",{exact:true}).click();
  }
  await page.getByRole("button",{name:"確認番号をLINEに送る",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("操作回数");expect(app.pushes).toHaveLength(expectedPushes);
  await fixture(page,"scenario",{lineFailure:null,consumed:0});await fixture(page,"advance",{ms:60001});
  if(failure!=="quota")await page.getByText("確認番号が届かない・期限が切れたとき",{exact:true}).click();
  await sendPin(page);expect(app.pushes).toHaveLength(expectedPushes+1);
  const pin=(await(await fixture(page,"pin")).json()).pin;
  await page.getByLabel("確認番号",{exact:true}).fill(pin);await page.getByRole("button",{name:"確認する",exact:true}).click();
  await expect(page.getByRole("heading",{name:"準備ができました"})).toBeVisible();expect(app.writes).toEqual([]);
});

test("automatic PIN expiry and changing LINE invalidate old verification and never automatically retry",async({page})=>{
  await fixture(page,"scenario",{autoPin:true});await connect(page);await page.getByRole("button",{name:"この店舗を使う"}).click();
  const code=await page.getByTestId("line-code").textContent();await fixture(page,"line",{code,userId:"line-fixture"});
  const oldPin=(await(await fixture(page,"pin")).json()).pin;await fixture(page,"advance",{ms:300001});await page.reload();
  await expect(page.getByText("確認番号の期限が切れたか",{exact:false})).toBeVisible();await expect(page.getByLabel("確認番号",{exact:true})).toHaveCount(0);expect(app.pushes).toHaveLength(1);
  await page.getByText("通知先のLINEを変更する・登録コードを送り直す",{exact:true}).click();await page.getByRole("button",{name:"コードを再発行",exact:true}).click();
  const fresh=await page.getByTestId("line-code").textContent();expect(fresh).not.toBe(code);await fixture(page,"line",{code:fresh,userId:"line-other"});await page.reload();
  await page.getByLabel("確認番号",{exact:true}).fill(oldPin);await page.getByRole("button",{name:"確認する",exact:true}).click();await expect(page.getByRole("alert")).toContainText("確認番号が違うか");
  const newPin=(await(await fixture(page,"pin")).json()).pin;await page.getByLabel("確認番号",{exact:true}).fill(newPin);await page.getByRole("button",{name:"確認する",exact:true}).click();await expect(page.getByRole("heading",{name:"準備ができました"})).toBeVisible();
  expect(app.pushes.map(x=>x.to)).toEqual(["line-fixture","line-other"]);expect(app.writes).toEqual([]);
});

test("automatic detection before the delivery claim keeps polling until the PIN is ready",async({page})=>{
  await fixture(page,"scenario",{autoPin:true});await connect(page);await page.getByRole("button",{name:"この店舗を使う"}).click();
  const code=await page.getByTestId("line-code").textContent();await fixture(page,"line",{code,userId:"line-fixture"});
  let idleSeen=false,polls=0;
  await page.route("**/api/self/status",async route=>{
    const response=await route.fetch(),state=await response.json();polls++;
    if(!idleSeen&&state.lineDetected){idleSeen=true;state.lineCheck={state:"idle",code:null,pinAvailable:false,expiresAt:null,retryAfterMs:0};}
    await route.fulfill({response,json:state});
  });
  await page.reload();await expect(page.getByLabel("確認番号",{exact:true})).toBeVisible({timeout:9000});
  expect(idleSeen).toBe(true);expect(polls).toBeGreaterThan(1);expect(app.pushes).toHaveLength(1);expect(app.writes).toEqual([]);
});

test("automatic idle wait is bounded and offers manual recovery without sending",async({page})=>{
  await fixture(page,"scenario",{autoPin:true});await connect(page);await page.getByRole("button",{name:"この店舗を使う"}).click();
  const code=await page.getByTestId("line-code").textContent();await fixture(page,"line",{code,userId:"line-fixture"});
  await page.route("**/api/self/status",async route=>{
    const response=await route.fetch(),state=await response.json();state.lineCheck={state:"idle",code:null,pinAvailable:false,expiresAt:null,retryAfterMs:0};await route.fulfill({response,json:state});
  });
  await page.reload();await page.getByText("確認番号が届かない・期限が切れたとき",{exact:true}).click();
  await expect(page.getByRole("button",{name:"確認番号をLINEに送る",exact:true})).toBeDisabled();
  await page.evaluate(()=>{const realNow=Date.now;Date.now=()=>realNow()+91000;});
  await expect(page.getByRole("button",{name:"確認番号をLINEに送る",exact:true})).toBeEnabled({timeout:9000});
  await expect(page.getByText("LINEの送信を保留しました",{exact:false})).toBeVisible();expect(app.pushes).toHaveLength(1);expect(app.writes).toEqual([]);
});

for (const lineFailure of [null, "unknown"]) test(`open automatic PIN ${lineFailure ?? "sent"} screen expires without reload or another push`, async ({page}) => {
  await fixture(page, "scenario", {autoPin: true, lineFailure});
  let manual = 0;
  page.on("request", r => {if (r.url().endsWith("/api/self/line/test")) manual++;});
  await connect(page);
  await page.getByRole("button", {name: "この店舗を使う"}).click();
  const code = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", {code, userId: "line-fixture"});
  await page.reload();
  const input = page.getByLabel("確認番号", {exact: true});
  await expect(input).toBeVisible();
  const oldPin = (await (await fixture(page, "pin")).json()).pin;
  await input.fill(oldPin);
  await page.clock.install({time: new Date()});
  await fixture(page, "advance", {ms: 240000});
  await page.clock.fastForward(240000);
  await expect(input).toHaveValue(oldPin);
  expect(app.pushes).toHaveLength(1);
  await fixture(page, "advance", {ms: 61000});
  await page.clock.fastForward(61000);
  await expect(input).toHaveCount(0, {timeout: 9000});
  if (lineFailure === "unknown")
    await expect(page.getByText("届いている番号は入力できます", {exact: false})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "確認番号をLINEに送る", exact: true})).toBeVisible();
  expect(app.pushes).toHaveLength(1);
  expect(manual).toBe(0);
  expect(app.writes).toEqual([]);
  await page.setViewportSize({width: 375, height: 812});
  await page.screenshot({path: `../output/meo-line-one-return-20261001/pin-expiry-local-fix/expired-${lineFailure ?? "sent"}-375.png`, fullPage: true});
  await fixture(page, "scenario", {lineFailure: null});
  await sendPin(page);
  const newPin = (await (await fixture(page, "pin")).json()).pin;
  await input.fill(newPin);
  await page.getByRole("button", {name: "確認する", exact: true}).click();
  await expect(page.getByRole("heading", {name: "準備ができました"})).toBeVisible();
  expect(app.pushes).toHaveLength(2);
  expect(manual).toBe(1);
  expect(app.writes).toEqual([]);
});
