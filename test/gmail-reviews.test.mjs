// 決定的ユニットテスト（実Gmailを叩かない・モックfetch）
// 実行: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccessToken, searchMessages, getMessage, fetchReviewNotificationEmails } from "../src/gmail-reviews.mjs";

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("getAccessToken: トークンエンドポイントにrefresh_tokenを渡す", async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return new Response(JSON.stringify({ access_token: "AT123", expires_in: 3599 }), { status: 200 });
  };
  const { accessToken, expiresIn } = await getAccessToken({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "rt",
    fetchImpl,
  });
  assert.equal(accessToken, "AT123");
  assert.equal(expiresIn, 3599);
  assert.equal(captured.url, "https://oauth2.googleapis.com/token");
  assert.match(captured.opts.body.toString(), /grant_type=refresh_token/);
});

test("getAccessToken: 必須項目が欠けたら例外", async () => {
  await assert.rejects(() => getAccessToken({ clientId: "id" }));
});

test("getAccessToken: エラー時はステータス付きで例外", async () => {
  const fetchImpl = async () => new Response("invalid_grant", { status: 400 });
  await assert.rejects(
    () => getAccessToken({ clientId: "a", clientSecret: "b", refreshToken: "c", fetchImpl }),
    /トークン更新失敗 400/
  );
});

test("searchMessages: クエリをURLに反映し、messages配列を返す", async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 });
  };
  const messages = await searchMessages({ accessToken: "AT", query: "from:google.com", fetchImpl });
  assert.deepEqual(messages, [{ id: "m1", threadId: "t1" }]);
  assert.match(capturedUrl, /\/messages\?/);
  assert.match(decodeURIComponent(capturedUrl), /q=from:google\.com/);
});

test("searchMessages: 該当0件ならば空配列", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
  const messages = await searchMessages({ accessToken: "AT", query: "x", fetchImpl });
  assert.deepEqual(messages, []);
});

test("getMessage: ヘッダーとtext/plain本文をデコードして返す", async () => {
  const fakeMessage = {
    id: "m1",
    snippet: "新しいクチコミが届きました",
    payload: {
      headers: [
        { name: "Subject", value: "新しいクチコミが届きました" },
        { name: "From", value: "Google ビジネス プロフィール <businessprofile-noreply@google.com>" },
        { name: "Date", value: "Tue, 16 Jun 2026 10:00:00 +0900" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("お客様から新しいクチコミが届きました。") } },
        { mimeType: "text/html", body: { data: b64url("<p>html版</p>") } },
      ],
    },
  };
  const fetchImpl = async () => new Response(JSON.stringify(fakeMessage), { status: 200 });
  const msg = await getMessage({ accessToken: "AT", id: "m1", fetchImpl });
  assert.equal(msg.subject, "新しいクチコミが届きました");
  assert.match(msg.from, /businessprofile-noreply@google\.com/);
  assert.equal(msg.text, "お客様から新しいクチコミが届きました。");
  assert.match(msg.html, /html版/);
});

test("fetchReviewNotificationEmails: トークン取得→検索→各メッセージ取得の順で呼ぶ", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/token")) {
      return new Response(JSON.stringify({ access_token: "AT", expires_in: 3599 }), { status: 200 });
    }
    if (String(url).includes("/messages?")) {
      return new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: "m", snippet: "s", payload: { headers: [], mimeType: "text/plain", body: { data: b64url("本文") } } }),
      { status: 200 }
    );
  };
  const emails = await fetchReviewNotificationEmails({
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "rt",
    fetchImpl,
  });
  assert.equal(emails.length, 2);
  assert.equal(calls.filter((u) => u.includes("/messages/")).length, 2);
});

import { parseGbpReviewEmail } from "../src/gmail-reviews.mjs";

const gbpMsg = (overrides = {}) => ({
  id: "m1",
  subject: "「テスト店舗」に新しいクチコミが届きました",
  from: "Google ビジネス プロフィール <businessprofile-noreply@google.com>",
  date: "Tue, 17 Jun 2026 10:00:00 +0900",
  snippet: "テスト",
  text: "山田 太郎 さんがクチコミを投稿しました\n★★★★☆\n\nとても良いお店です。スタッフも親切でした。",
  html: "",
  ...overrides,
});

test("parseGbpReviewEmail: 非GBP送信元は null を返す", () => {
  const result = parseGbpReviewEmail({
    ...gbpMsg(),
    from: "spam@example.com",
  });
  assert.equal(result, null);
});

test("parseGbpReviewEmail: 件名から店舗名を抽出する", () => {
  const result = parseGbpReviewEmail(gbpMsg());
  assert.ok(result !== null);
  assert.equal(result.businessName, "テスト店舗");
});

test("parseGbpReviewEmail: ★記号から星評価を抽出する", () => {
  const result = parseGbpReviewEmail(gbpMsg());
  assert.equal(result.star, 4);
});

test("parseGbpReviewEmail: 5 stars の英語表記を抽出する", () => {
  const result = parseGbpReviewEmail(gbpMsg({
    text: "John Smith left a review\n5 star rating\n\nGreat service!",
    subject: '"My Shop" received a new review',
  }));
  assert.ok(result !== null);
  assert.equal(result.star, 5);
});

test("parseGbpReviewEmail: パース失敗時も rawText を返す", () => {
  const result = parseGbpReviewEmail(gbpMsg({
    text: "何も特定できないテキスト",
    subject: "新しいクチコミ",
  }));
  assert.ok(result !== null);
  assert.ok(typeof result.rawText === "string");
  assert.ok(result.rawText.length > 0);
});

test("parseGbpReviewEmail: google-my-business-noreply も GBP と認識する", () => {
  const result = parseGbpReviewEmail(gbpMsg({
    from: "Google My Business <google-my-business-noreply@google.com>",
  }));
  assert.ok(result !== null);
});
