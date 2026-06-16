// デモ用: 追加業種の口コミ返信下書きを Groq で実生成（焼き込み用）
// 鍵は環境変数から（source ~/.config/ai-keys/load.sh）。値は出力しない。
// 出力: demo-drafts.json（HTMLに焼き込む実AI出力）

import { writeFileSync } from "node:fs";

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) { console.error("GROQ_API_KEY 未設定"); process.exit(1); }
const GROQ_MODEL = "llama-3.3-70b-versatile";

const buildSystem = (bizType, bizName) => `あなたは${bizType}「${bizName}」のオーナーです。
Googleビジネスプロフィールに届いたお客様の口コミに対する返信を書いてください。

【出力形式・厳守】
- 出力は「返信本文」のみ。「下書き：」「返信の下書き:」などの前置き・見出しを一切付けない
- （）やカッコ内の注釈・指示書きを出力に含めない
- 名前のプレースホルダー（「〇〇様」「（お客様の名前）様」等）を使わない。名前は本文に与えられた場合のみ使い、無ければ名前を入れずに書く

【内容のルール】
- 日本語の口コミには日本語、英語の口コミには英語で返信する
- 2〜4文で簡潔に。定型文の使い回しに見えないよう、口コミの具体的な内容に必ず触れる
- 高評価には感謝を、不満には誠実な謝罪と改善・再来の意思を示す。決して言い訳・反論をしない
- やっていないキャンペーン等の事実を捏造しない
- 効果・治療・結果を保証する断定的な表現は避ける`;

const datasets = [
  {
    key: "restaurant", label: "飲食店", bizType: "炭火焼き居酒屋", bizName: "炭火焼き 楽",
    reviews: [
      { star: 1, name: "山口 大輔", date: "4日前", text: "予約していたのに席が用意されておらず、20分以上待たされました。料理が来るのも遅くて残念でした。" },
      { star: 2, name: "森 あや", date: "2週間前", text: "料理は美味しかったのですが、隣の席の声が大きくて落ち着いて食べられませんでした。" },
      { star: 5, name: "斎藤 健一", date: "3日前", text: "名物の炭火焼きが最高でした！スタッフさんの接客も丁寧で、また絶対に来ます。" },
      { star: 4, name: "小林 まり", date: "1週間前", text: "料理は美味しいです。ただ人気店なので予約が取りづらいのだけが難点です。" },
      { star: 5, name: "Daniel K.", date: "1か月前", text: "Amazing charcoal-grilled yakitori and a great atmosphere! The staff were super friendly. Highly recommend." },
    ],
  },
  {
    key: "seitai", label: "整体院", bizType: "整体院", bizName: "整体院 こころ",
    reviews: [
      { star: 1, name: "田村 さとし", date: "5日前", text: "施術後もあまり変化を感じられず、しかも次回予約をしつこく勧められて少し不快でした。" },
      { star: 2, name: "中井 ゆか", date: "2週間前", text: "先生の施術は良かったのですが、予約時間より15分待たされました。" },
      { star: 5, name: "橋本 直子", date: "4日前", text: "長年の肩こりがとても楽になりました。一つ一つ丁寧に説明してくれて安心できました。" },
      { star: 4, name: "岡田 隆", date: "1週間前", text: "腰の張りが軽くなりました。ただ、少し料金が高めかなと感じました。" },
      { star: 3, name: "西村 あきら", date: "3週間前", text: "可もなく不可もなく、普通の整体院という印象でした。" },
    ],
  },
];

async function callGroq(system, userText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [ { role: "system", content: system }, { role: "user", content: `口コミ（星${userText.star}）:\n${userText.text}` } ],
      temperature: 0.6, max_tokens: 300,
    }),
  });
  const data = await res.json();
  if (!res.ok) return `【ERROR ${res.status}】${JSON.stringify(data).slice(0, 200)}`;
  return data.choices?.[0]?.message?.content?.trim() ?? "(空)";
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = {};
const nonJp = /[가-힣一-鿿]/; // 後で目視チェック用ではなくハングルだけ検出
const hangul = /[가-힣]/;

for (const d of datasets) {
  const system = buildSystem(d.bizType, d.bizName);
  out[d.key] = { label: d.label, bizName: d.bizName, items: [] };
  for (const r of d.reviews) {
    process.stderr.write(`[${d.label}] 星${r.star}...\n`);
    const reply = await callGroq(system, r);
    const warn = hangul.test(reply) ? " ⚠️ハングル混入" : "";
    process.stderr.write(`  -> ${reply.slice(0, 30)}...${warn}\n`);
    out[d.key].items.push({ star: r.star, name: r.name, date: r.date, text: r.text, reply });
    await sleep(900);
  }
}

writeFileSync(new URL("./demo-drafts.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("完了 -> ~/dev/meo-harness/demo-drafts.json");
