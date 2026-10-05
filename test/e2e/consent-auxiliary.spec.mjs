import { test, expect } from "@playwright/test";
import { startTestApp } from "../support/self-browser.mjs";

const consentMessage = "利用条件を確認し、チェックを入れてください。";
let app, unexpected, requests;

test.beforeEach(async ({ context }) => {
  app = await startTestApp();
  unexpected = [];
  requests = [];
  await context.setExtraHTTPHeaders({ "X-Fixture-Key": app.fixtureKey });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "challenges.cloudflare.com" && url.pathname === "/turnstile/v0/api.js")
      return route.fulfill({ contentType: "text/javascript", body: 'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};' });
    if (url.origin === app.baseURL) {
      requests.push({ method: request.method(), path: url.pathname });
      return route.continue();
    }
    unexpected.push(url.origin);
    return route.abort("blockedbyclient");
  });
});

test.afterEach(async ({ context }) => {
  try {
    expect(unexpected).toEqual([]);
    expect(app.unexpected).toEqual([]);
    expect(app.writes).toEqual([]);
  } finally {
    await context.close();
    await app.stop();
  }
});

const fixture = (page, path, data = {}) => page.request.post(app.baseURL + "/fixture/" + path, {
  data, headers: { "X-Fixture-Key": app.fixtureKey },
});
const auxiliary = (page) => page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^接続の切断・ログアウト$/ }) });
const action = (page, name) => page.getByRole("button", { name, exact: true, includeHidden: true });
const mutationPaths = () => requests.filter(r => r.method !== "GET" && r.path.startsWith("/api/self/")).map(r => r.path);
const status = async (page) => (await page.request.get(app.baseURL + "/api/self/status")).json();

async function connect(page) {
  await page.goto(app.baseURL + "/start");
  await page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true }).click();
  await page.getByRole("button", { name: "架空Googleで許可", exact: true }).click();
  await expect(page.getByRole("button", { name: "この店舗を使う", exact: true })).toBeVisible();
}

async function selectStore(page) {
  await page.getByRole("button", { name: "この店舗を使う", exact: true }).click();
  return page.getByTestId("line-code").textContent();
}

async function verifyLine(page, code) {
  expect((await fixture(page, "line", { code, userId: "line-consent-fixture" })).ok()).toBe(true);
  await page.getByRole("button", { name: "状態を更新", exact: true }).click();
  const [sent] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith("/api/self/line/test")),
    page.getByRole("button", { name: "確認番号をLINEに送る", exact: true }).click(),
  ]);
  expect(sent.ok()).toBe(true);
  await expect(page.getByText("LINEに確認番号を送りました。届いている6桁を入力してください。", { exact: true })).toBeVisible();
  const pin = (await (await fixture(page, "pin")).json()).pin;
  await page.getByLabel("確認番号", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "準備ができました", exact: true })).toBeVisible();
}

async function collapsedActions(page) {
  const details = auxiliary(page);
  await expect(details.locator("summary")).toBeVisible();
  await expect(details).toHaveJSProperty("open", false);
  for (const name of ["接続を切断", "ログアウト"]) {
    await expect(action(page, name)).toHaveCount(1);
    await expect(action(page, name)).toBeHidden();
  }
}

async function exposedActions(page) {
  await expect(auxiliary(page)).toHaveCount(0);
  await expect(action(page, "接続を切断")).toBeVisible();
  await expect(action(page, "ログアウト")).toBeVisible();
}

for (const [state, width] of [["line_verified", 320], ["ready", 375]]) {
  test(`unchecked consent has an associated inline error and requires explicit activation from ${state}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await connect(page);
    await verifyLine(page, await selectStore(page));
    if (state === "ready") {
      await app.db.prepare("UPDATE stores SET state='ready'").run();
      await page.reload();
    }
    const checkbox = page.getByRole("checkbox", { name: "利用条件を確認しました", exact: true });
    const start = page.getByRole("button", { name: "利用を開始する", exact: true });
    const error = page.getByText(consentMessage, { exact: true });
    await expect(checkbox).not.toBeChecked();
    await expect(error).toBeHidden();
    requests = [];
    await start.click();
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(checkbox).toBeFocused();
    await expect(checkbox).toHaveAttribute("aria-invalid", "true");
    const errorId = await error.getAttribute("id");
    expect(errorId).toBeTruthy();
    expect((await checkbox.getAttribute("aria-describedby") ?? "").split(/\s+/)).toContain(errorId);
    const errorBox = await error.boundingBox(), checkboxBox = await checkbox.boundingBox(), startBox = await start.boundingBox();
    expect(errorBox.y).toBeGreaterThanOrEqual(checkboxBox.y + checkboxBox.height);
    expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(startBox.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(mutationPaths()).toEqual([]);
    expect(await app.db.prepare("SELECT state,terms_version FROM stores").first()).toEqual({ state, terms_version: null });
    await page.screenshot({ path: `output/consent-auxiliary/consent-error-${width}.png`, fullPage: true });
    await checkbox.check();
    await expect(error).toBeHidden();
    await expect(checkbox).not.toHaveAttribute("aria-invalid", "true");
    expect((await checkbox.getAttribute("aria-describedby") ?? "").split(/\s+/)).not.toContain(errorId);
    expect(mutationPaths()).toEqual([]);
    expect((await status(page)).state).toBe(state);
    const [activated] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/self/activate")),
      start.click(),
    ]);
    expect(activated.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "稼働中", exact: true })).toBeVisible();
    expect(mutationPaths()).toEqual(["/api/self/activate"]);
    expect((await status(page)).state).toBe("active");
  });
}

test("setup auxiliary actions stay open on same-step refresh and do not disconnect or logout until explicitly confirmed", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page);
  await collapsedActions(page);
  const code = await selectStore(page);
  await collapsedActions(page);
  requests = [];
  await auxiliary(page).locator("summary").click();
  await expect(action(page, "接続を切断")).toBeVisible();
  await expect(action(page, "ログアウト")).toBeVisible();
  expect(mutationPaths()).toEqual([]);
  expect((await fixture(page, "line", { code, userId: "line-auxiliary-fixture" })).ok()).toBe(true);
  await page.getByRole("button", { name: "状態を更新", exact: true }).click();
  await expect(page.getByText("LINEを検出しました。6桁の番号で通知先を確認します。", { exact: true })).toBeVisible();
  expect((await status(page)).state).toBe("line_pending");
  await expect(auxiliary(page)).toHaveJSProperty("open", true);
  await expect(action(page, "接続を切断")).toBeVisible();
  await expect(action(page, "ログアウト")).toBeVisible();
  expect(mutationPaths()).toEqual([]);
  await page.screenshot({ path: "output/consent-auxiliary/auxiliary-open-375.png", fullPage: true });
  await action(page, "接続を切断").click();
  await expect(page.getByRole("heading", { name: "Googleとの接続を切断しますか？", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "切断してデータを削除", exact: true })).toBeVisible();
  expect(mutationPaths()).toEqual([]);
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(page.getByRole("heading", { name: "いつものLINEを通知先に", exact: true })).toBeVisible();
  expect(mutationPaths()).toEqual([]);
  expect((await status(page)).state).toBe("line_pending");
  expect((await app.db.prepare("SELECT count(*) n FROM google_credentials").first()).n).toBe(1);
  if (!(await auxiliary(page).evaluate(el => el.open))) await auxiliary(page).locator("summary").click();
  const [loggedOut] = await Promise.all([
    page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/self/logout")),
    action(page, "ログアウト").click(),
  ]);
  expect(loggedOut.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "初めての方：Googleでお店を接続", exact: true })).toBeVisible();
  expect(mutationPaths()).toEqual(["/api/self/logout"]);
  expect((await status(page)).state).toBe("anonymous");
  expect((await app.db.prepare("SELECT count(*) n FROM stores").first()).n).toBe(1);
  expect(app.pushes).toEqual([]);
});

test("only ordinary setup states collapse account actions while running recovery pilot and closed intake keep them exposed", async ({ page }) => {
  await connect(page);
  expect((await status(page)).state).toBe("google_connected");
  await collapsedActions(page);
  await fixture(page, "scenario", { registration: false });
  await page.reload();
  await expect(page.getByRole("heading", { name: "新規受付はお休み中です", exact: true })).toBeVisible();
  await exposedActions(page);
  await fixture(page, "scenario", { registration: true });
  await page.reload();
  await verifyLine(page, await selectStore(page));
  requests = [];
  // Seed lifecycle states in the local D1 fixture, but use the real status API and renderer.
  for (const state of ["location_selected", "line_pending", "line_verified", "ready", "active", "paused", "needs_google_reconnect"]) {
    await app.db.prepare("UPDATE stores SET state=?").bind(state).run();
    await page.reload();
    expect((await status(page)).state).toBe(state);
    if (["active", "paused", "needs_google_reconnect"].includes(state)) await exposedActions(page);
    else await collapsedActions(page);
  }
  await app.db.prepare("UPDATE stores SET state='line_verified'").run();
  await fixture(page, "scenario", { registration: false });
  await page.reload();
  expect((await status(page)).registrationAllowed).toBe(false);
  await exposedActions(page);
  await fixture(page, "scenario", { pilot: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "お店の接続確認ができました", exact: true })).toBeVisible();
  await exposedActions(page);
  await fixture(page, "scenario", { pilot: true, pilotOwner: "not-alice" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "新規受付はお休み中です", exact: true })).toBeVisible();
  await exposedActions(page);
  expect(mutationPaths()).toEqual([]);
});
