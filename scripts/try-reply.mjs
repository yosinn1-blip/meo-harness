// ライブ確認: reply-engine を実Groqで動かす（既定プロバイダの疎通＆品質目視）
// 実行: source ~/.config/ai-keys/load.sh && node scripts/try-reply.mjs
// 鍵は環境変数から。値は出力しない。
import { generateReply, PROVIDERS } from "../src/reply-engine.mjs";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY 未設定（source ~/.config/ai-keys/load.sh を先に）");
  process.exit(1);
}

const cases = [
  { business: { type: "ヘアサロン", name: "ソフィア" }, review: { star: 1, text: "予約していたのに30分待たされました。カラーも希望と違う色に仕上がってがっかりです。" } },
  { business: { type: "ヘアサロン", name: "ソフィア" }, review: { star: 5, text: "Great haircut and very friendly staff! Will come back next time I'm in Japan." } },
  { business: { type: "整体院", name: "こころ" }, review: { star: 5, text: "長年の肩こりがとても楽になりました。丁寧に説明してくれて安心できました。" } },
  { business: { type: "炭火焼き居酒屋", name: "楽" }, review: { star: 2, text: "料理は美味しかったのですが、隣の席の声が大きくて落ち着いて食べられませんでした。" } },
];

let warned = 0;
for (const c of cases) {
  const res = await generateReply({ review: c.review, business: c.business, providerConfig: { apiKey } });
  const flag = res.warnings.length ? ` ⚠️ ${res.warnings.join(",")}` : "";
  if (res.warnings.length) warned++;
  console.log(`\n── ${c.business.type}「${c.business.name}」 ★${c.review.star} (${res.ms}ms, ${res.tokens}tok)${flag}`);
  console.log(`口コミ: ${c.review.text}`);
  console.log(`返信  : ${res.text}`);
}
console.log(`\n完了: ${cases.length}件 / プロバイダ=${PROVIDERS.GROQ} / 警告 ${warned}件`);
