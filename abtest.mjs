// GBP口コミ返信 ABテスト: Groq(Llama-3.3-70b) vs Gemini Flash
// 鍵は環境変数から（source ~/.config/ai-keys/load.sh 経由）。値は出力しない。
// 出力: ab-test-results.md（人が見て既定プロバイダを選ぶ）

import { writeFileSync } from "node:fs";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GROQ_KEY) { console.error("GROQ_API_KEY 未設定"); process.exit(1); }
if (!GEMINI_KEY) { console.error("GEMINI_API_KEY 未設定"); process.exit(1); }

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-2.5-flash";

// 店舗設定（架空のヘアサロン）と返信方針
const SYSTEM = `あなたは個人経営のヘアサロン「ソフィア」のオーナーです。
Googleビジネスプロフィールに届いたお客様の口コミに対する返信を書いてください。

【出力形式・厳守】
- 出力は「返信本文」のみ。「下書き：」「返信の下書き:」などの前置き・見出しを一切付けない
- （）やカッコ内の注釈・指示書き（例:「（確認してください）」）を出力に含めない
- 名前のプレースホルダー（「〇〇様」「（お客様の名前）様」等）を使わない。お客様の名前は本文に与えられた場合のみ使い、無ければ名前を入れずに書く

【内容のルール】
- 日本語の口コミには日本語、英語の口コミには英語で返信する
- 2〜4文で簡潔に。定型文の使い回しに見えないよう、口コミの具体的な内容に必ず触れる
- 高評価には感謝を、不満には誠実な謝罪と改善・再来の意思を示す。決して言い訳・反論をしない
- やっていないキャンペーン等の事実を捏造しない`;

const reviews = [
  { star: 5, text: "カットもカラーも丁寧で、髪型の相談にもしっかり乗ってくれました。担当の田中さんありがとうございました！" },
  { star: 5, text: "最高でした！" },
  { star: 1, text: "予約していたのに30分待たされました。カラーも希望と違う色に仕上がってがっかりです。" },
  { star: 2, text: "技術は悪くないけど、スタッフ同士の私語が多くて落ち着けませんでした。" },
  { star: 3, text: "普通でした。可もなく不可もなく。値段は妥当だと思います。" },
  { star: 4, text: "カットは良かったです。ただ予約が取りづらいのが難点。ネット予約がもっと充実すると嬉しいです。" },
  { star: 5, text: "Great haircut and very friendly staff! Will come back next time I'm in Japan." },
  { star: 1, text: "二度と行きません。最悪。" },
  { star: 4, text: "仕上がりは満足ですが、想像より少し高かったです。" },
  { star: 5, text: "いつもお世話になっています。今回も素敵にしてもらえました！" },
];

async function callGroq(userText) {
  const t0 = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [ { role: "system", content: SYSTEM }, { role: "user", content: `口コミ（星${userText.star}）:\n${userText.text}` } ],
      temperature: 0.6, max_tokens: 300,
    }),
  });
  const ms = Date.now() - t0;
  const data = await res.json();
  if (!res.ok) return { ms, text: `【ERROR ${res.status}】${JSON.stringify(data).slice(0, 300)}`, tokens: 0 };
  return { ms, text: data.choices?.[0]?.message?.content?.trim() ?? "(空)", tokens: data.usage?.total_tokens ?? 0 };
}

async function callGemini(userText, attempt = 0) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `口コミ（星${userText.star}）:\n${userText.text}` }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const ms = Date.now() - t0;
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429 && attempt < 2) { await sleep(7000); return callGemini(userText, attempt + 1); }
    return { ms, text: `【ERROR ${res.status}】${JSON.stringify(data).slice(0, 300)}`, tokens: 0 };
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim() ?? "(空)";
  return { ms, text, tokens: data.usageMetadata?.totalTokenCount ?? 0 };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let out = `# 口コミ返信 ABテスト結果: Groq(${GROQ_MODEL}) vs Gemini(${GEMINI_MODEL})\n\n生成日時: ${new Date().toISOString()}\n\n`;
const stat = { groq: { ms: [], tok: [], err: 0 }, gemini: { ms: [], tok: [], err: 0 } };

for (let i = 0; i < reviews.length; i++) {
  const r = reviews[i];
  process.stderr.write(`[${i + 1}/${reviews.length}] 星${r.star}...\n`);
  const g = await callGroq(r);
  await sleep(800);
  const m = await callGemini(r);
  await sleep(800);
  if (g.text.startsWith("【ERROR")) stat.groq.err++; else { stat.groq.ms.push(g.ms); stat.groq.tok.push(g.tokens); }
  if (m.text.startsWith("【ERROR")) stat.gemini.err++; else { stat.gemini.ms.push(m.ms); stat.gemini.tok.push(m.tokens); }
  out += `## ${i + 1}. ★${r.star}\n\n> ${r.text}\n\n`;
  out += `**Groq** (${g.ms}ms, ${g.tokens}tok)\n\n${g.text}\n\n`;
  out += `**Gemini** (${m.ms}ms, ${m.tokens}tok)\n\n${m.text}\n\n---\n\n`;
}

const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
const summary = `## サマリー\n\n| 指標 | Groq | Gemini |\n|---|---|---|\n| 平均応答 | ${avg(stat.groq.ms)}ms | ${avg(stat.gemini.ms)}ms |\n| 平均トークン | ${avg(stat.groq.tok)} | ${avg(stat.gemini.tok)} |\n| エラー数 | ${stat.groq.err} | ${stat.gemini.err} |\n\n`;
out = out.replace(/\n\n/, "\n\n" + summary);

writeFileSync(new URL("./ab-test-results.md", import.meta.url), out);
console.log(`完了: ${reviews.length}件 × 2プロバイダ`);
console.log(`Groq  平均 ${avg(stat.groq.ms)}ms / err ${stat.groq.err}`);
console.log(`Gemini平均 ${avg(stat.gemini.ms)}ms / err ${stat.gemini.err}`);
console.log(`結果: ~/dev/meo-harness/ab-test-results.md`);
