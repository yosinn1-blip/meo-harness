// 決定的ユニットテスト（ライブLINEを叩かない・dryRun/モックfetch）
// 実行: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stars,
  truncate,
  buildDigestText,
  buildPushPayload,
  sendLineDigest,
  verifyLineCredentials,
  _internals,
} from "../src/line-notify.mjs";

test("stars: 星表示", () => {
  assert.equal(stars(5), "★★★★★");
  assert.equal(stars(1), "★☆☆☆☆");
  assert.equal(stars(0), "☆☆☆☆☆");
  assert.equal(stars(9), "★★★★★"); // 上限クランプ
});

test("truncate: 切り詰めと空白正規化", () => {
  assert.equal(truncate("あいうえお", 10), "あいうえお");
  assert.equal(truncate("あいうえおかきくけこ", 5), "あいうえ…");
  assert.equal(truncate("a\n b  c", 10), "a b c");
});

const sampleReviews = [
  { star: 1, name: "山口 大輔", text: "予約していたのに席が用意されておらず、20分以上待たされました。", draft: "ご来店いただきありがとうございます。お待たせしてしまい申し訳ございません。" },
  { star: 5, name: "斎藤 健一", text: "名物の炭火焼きが最高でした！また絶対に来ます。", draft: "うれしいお言葉をありがとうございます。またのお越しをお待ちしております。" },
  { star: 4, name: "小林 まり", text: "料理は美味しいです。予約が取りづらいのだけが難点です。", draft: "ありがとうございます。ご予約の取りづらさは改善に努めます。" },
];

test("buildDigestText: 件数ヘッダ・店名・返信案・ダッシュボードURL", () => {
  const text = buildDigestText(sampleReviews, { bizName: "炭火焼き 楽", dashboardUrl: "https://x.test/d" });
  assert.match(text, /新着クチコミ 3件（炭火焼き 楽）/);
  assert.match(text, /返信案:/);
  assert.match(text, /https:\/\/x\.test\/d/);
  assert.match(text, /★☆☆☆☆ ⚠️ 山口 大輔/); // 低評価マーカー
});

test("buildDigestText: max超過は「ほかN件」", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ star: 3, text: `口コミ${i}` }));
  const text = buildDigestText(many, { max: 5 });
  assert.match(text, /新着クチコミ 8件/);
  assert.match(text, /ほか 3件/);
});

test("buildDigestText: 5000字上限を超えない", () => {
  const huge = Array.from({ length: 50 }, (_, i) => ({ star: 3, text: "あ".repeat(200), draft: "い".repeat(200), name: `客${i}` }));
  const text = buildDigestText(huge, { max: 50, reviewChars: 200, draftChars: 200 });
  assert.ok(text.length <= _internals.MAX_TEXT, `length=${text.length}`);
});

test("buildPushPayload: LINE pushの形", () => {
  const p = buildPushPayload({ to: "U123", reviews: sampleReviews, digest: { bizName: "楽" } });
  assert.equal(p.to, "U123");
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].type, "text");
  assert.match(p.messages[0].text, /新着クチコミ/);
});

test("sendLineDigest: dryRunはペイロードだけ返す（送らない）", async () => {
  const res = await sendLineDigest({ to: "U123", reviews: sampleReviews, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.sent, 0);
  assert.equal(res.payload.to, "U123");
});

test("sendLineDigest: 新着0件はスキップ", async () => {
  const res = await sendLineDigest({ to: "U123", reviews: [], dryRun: false });
  assert.deepEqual(res, { skipped: "no-reviews", sent: 0 });
});

test("sendLineDigest: 送信先未指定は例外", async () => {
  await assert.rejects(sendLineDigest({ reviews: sampleReviews, dryRun: true }), /userId/);
});

test("sendLineDigest: 正常送信（モックfetchでURL/ヘッダ/ボディ検証）", async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const res = await sendLineDigest({
    channelAccessToken: "TOKEN_X",
    to: "U123",
    reviews: sampleReviews,
    digest: { bizName: "楽" },
    fetchImpl: mockFetch,
  });
  assert.equal(res.sent, 1);
  assert.equal(captured.url, _internals.LINE_PUSH_URL);
  assert.equal(captured.init.headers.Authorization, "Bearer TOKEN_X");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.to, "U123");
  assert.match(body.messages[0].text, /新着クチコミ/);
});

test("sendLineDigest: 401はトークン無効として投げる", async () => {
  const mockFetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"Authentication failed"}' });
  await assert.rejects(
    sendLineDigest({ channelAccessToken: "bad", to: "U123", reviews: sampleReviews, fetchImpl: mockFetch }),
    (e) => e.status === 401 && /トークンが無効/.test(e.message),
  );
});

test("sendLineDigest: 429は無料枠/レート制限として投げる", async () => {
  const mockFetch = async () => ({ ok: false, status: 429, text: async () => "{}" });
  await assert.rejects(
    sendLineDigest({ channelAccessToken: "t", to: "U123", reviews: sampleReviews, fetchImpl: mockFetch }),
    (e) => e.status === 429 && /無料枠|レート/.test(e.message),
  );
});

test("verifyLineCredentials: トークン/userIdが空ならfalse（fetchを叩かない）", async () => {
  let called = false;
  const mockFetch = async () => { called = true; return { ok: true }; };
  assert.equal(await verifyLineCredentials({ channelAccessToken: "", userId: "U1", fetchImpl: mockFetch }), false);
  assert.equal(await verifyLineCredentials({ channelAccessToken: "t", userId: "", fetchImpl: mockFetch }), false);
  assert.equal(called, false);
});

test("verifyLineCredentials: profile APIが200ならtrue・URL/ヘッダ検証", async () => {
  let captured;
  const mockFetch = async (url, init) => { captured = { url, init }; return { ok: true }; };
  const ok = await verifyLineCredentials({ channelAccessToken: "TOKEN_X", userId: "U123", fetchImpl: mockFetch });
  assert.equal(ok, true);
  assert.equal(captured.url, `${_internals.LINE_PROFILE_URL}/U123`);
  assert.equal(captured.init.headers.Authorization, "Bearer TOKEN_X");
});

test("verifyLineCredentials: profile APIが401ならfalse", async () => {
  const mockFetch = async () => ({ ok: false, status: 401 });
  const ok = await verifyLineCredentials({ channelAccessToken: "bad", userId: "U123", fetchImpl: mockFetch });
  assert.equal(ok, false);
});
