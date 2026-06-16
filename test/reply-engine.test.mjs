// 決定的ユニットテスト（ライブAPIを叩かない・モック fetch）
// 実行: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  DEFAULT_MODELS,
  isHealthBiz,
  buildSystemPrompt,
  sanitizeReply,
  generateReply,
} from "../src/reply-engine.mjs";

test("isHealthBiz: 医療・治療系を判定", () => {
  assert.equal(isHealthBiz("整体院"), true);
  assert.equal(isHealthBiz("接骨院"), true);
  assert.equal(isHealthBiz("歯科クリニック"), true);
  assert.equal(isHealthBiz("炭火焼き居酒屋"), false);
  assert.equal(isHealthBiz("ヘアサロン"), false);
});

test("buildSystemPrompt: 医療系には効果保証禁止の一文を付ける", () => {
  const health = buildSystemPrompt({ bizType: "整体院", bizName: "こころ" });
  assert.match(health, /効果・治療・結果を保証する断定的な表現は避ける/);
  const normal = buildSystemPrompt({ bizType: "ヘアサロン", bizName: "ソフィア" });
  assert.doesNotMatch(normal, /効果・治療・結果を保証/);
  // 屋号・業種が埋め込まれる
  assert.match(normal, /ヘアサロン「ソフィア」/);
});

test("sanitizeReply: 前置きラベルを除去", () => {
  const { text } = sanitizeReply("返信の下書き：ご来店ありがとうございました。");
  assert.equal(text, "ご来店ありがとうございました。");
});

test("sanitizeReply: 全体を囲むクォートを除去", () => {
  assert.equal(sanitizeReply("「ありがとうございました。」").text, "ありがとうございました。");
  assert.equal(sanitizeReply('"Thank you so much!"').text, "Thank you so much!");
});

test("sanitizeReply: ハングル混入を警告する", () => {
  const { warnings } = sanitizeReply("ありがとうございます。감사합니다。");
  assert.ok(warnings.includes("hangul-contamination"));
});

test("sanitizeReply: 名前プレースホルダを警告する", () => {
  assert.ok(sanitizeReply("〇〇様、ありがとうございました。").warnings.includes("name-placeholder"));
  assert.ok(sanitizeReply("（お客様の名前）様、感謝します。ご来店に感謝します。").warnings.includes("name-placeholder"));
});

test("sanitizeReply: 空入力", () => {
  assert.deepEqual(sanitizeReply("   "), { text: "", warnings: ["empty"] });
  assert.deepEqual(sanitizeReply(null), { text: "", warnings: ["empty"] });
});

test("sanitizeReply: 正常な返信はそのまま通す", () => {
  const clean = "このたびはご来店ありがとうございました。またのお越しをお待ちしております。";
  assert.deepEqual(sanitizeReply(clean), { text: clean, warnings: [] });
});

// ---- generateReply: モック fetch で provider抽象 & リトライを検証 ----

function mockGroqFetch(replies) {
  let i = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: replies[Math.min(i++, replies.length - 1)] } }],
      usage: { total_tokens: 42 },
    }),
  });
}

test("generateReply: Groq既定モデルで下書きを返す", async () => {
  const res = await generateReply({
    review: { star: 5, text: "最高でした！" },
    business: { type: "ヘアサロン", name: "ソフィア" },
    fetchImpl: mockGroqFetch(["ありがとうございました。またのお越しをお待ちしております。"]),
  });
  assert.equal(res.provider, PROVIDERS.GROQ);
  assert.equal(res.model, DEFAULT_MODELS[PROVIDERS.GROQ]);
  assert.match(res.text, /ありがとうございました/);
  assert.deepEqual(res.warnings, []);
});

test("generateReply: ハングル混入は最大1回再生成して吸収する", async () => {
  // 1回目はハングル混入、2回目はクリーン
  const res = await generateReply({
    review: { star: 5, text: "ありがとう" },
    business: { type: "ヘアサロン", name: "ソフィア" },
    fetchImpl: mockGroqFetch([
      "ありがとうございます。감사합니다。",
      "ありがとうございます。またのお越しをお待ちしております。",
    ]),
  });
  assert.deepEqual(res.warnings, []);
  assert.doesNotMatch(res.text, /[가-힣]/);
});

test("generateReply: 未知のプロバイダは例外", async () => {
  await assert.rejects(
    generateReply({
      review: { star: 5, text: "x" },
      business: { type: "x", name: "y" },
      provider: "openai",
    }),
    /未知のプロバイダ/,
  );
});
