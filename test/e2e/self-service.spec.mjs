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
async function fixture(page, path, body = {}) {
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
  await expect(
    page.getByRole("button", { name: "確認する", exact: true }),
  ).toBeEnabled();
}
async function connect(page) {
  await page.goto(app.baseURL + "/start");
  await page.getByRole("button", { name: "Googleで接続", exact: true }).click();
  await page.getByRole("button", { name: "架空Googleで許可" }).click();
}
async function onboard(page) {
  await connect(page);
  await page
    .getByRole("button", { name: "この店舗を使う", exact: true })
    .first()
    .click();
  const code = await page.getByTestId("line-code").textContent();
  await fixture(page, "line", { code, userId: "line-fixture" });
  await page.getByRole("button", { name: "LINEの検出状態を更新" }).click();
  await sendPin(page);
  const pin = (await (await fixture(page, "pin")).json()).pin;
  await page.getByLabel("確認番号", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
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
  await page.getByRole("button", { name: "利用を再開" }).click();
  await expect(
    page.getByRole("heading", { name: "稼働中", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "接続を切断" }).click();
  await page.getByRole("button", { name: "切断してデータを削除" }).click();
  await expect(
    page.getByRole("button", { name: "Googleで接続", exact: true }),
  ).toBeVisible();
  expect(admin).toEqual([]);
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
});
test("denied Google authorization returns without secrets in URL", async ({
  page,
}) => {
  await page.goto(app.baseURL + "/start");
  await page.getByRole("button", { name: "Googleで接続", exact: true }).click();
  await page.getByRole("button", { name: "許可しない", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("権限が許可されません");
  expect(page.url()).toBe(app.baseURL + "/account");
});
test("closed intake keeps login and stop available", async ({ page }) => {
  await onboard(page);
  await fixture(page, "scenario", { registration: false });
  await page.reload();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(
    page.getByRole("heading", { name: "新規受付はお休み中です" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Googleでログイン", exact: true })
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
  await page.getByRole("button", { name: "LINEの検出状態を更新" }).click();
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
  await page.getByRole("button", { name: "LINEの検出状態を更新" }).click();
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
  await page.getByRole("button", { name: "接続を切断" }).click();
  await page.getByRole("button", { name: "切断してデータを削除" }).click();
  await expect(
    page.getByRole("button", { name: "Googleで接続", exact: true }),
  ).toBeVisible();
});
