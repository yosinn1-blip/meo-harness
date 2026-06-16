// 価値ループのdry-run実演: モック口コミ → step1エンジン(実Groq)でAI下書き → step2でLINEダイジェスト
// LINEアカウント不要（dryRun）。実Groqを使うので鍵は要る。
// 実行: source ~/.config/ai-keys/load.sh && node scripts/try-digest.mjs
import { generateReply } from "../src/reply-engine.mjs";
import { sendLineDigest } from "../src/line-notify.mjs";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY 未設定（source ~/.config/ai-keys/load.sh を先に）");
  process.exit(1);
}

const business = { type: "炭火焼き居酒屋", name: "炭火焼き 楽" };
const mockReviews = [
  { star: 1, name: "山口 大輔", text: "予約していたのに席が用意されておらず、20分以上待たされました。料理が来るのも遅くて残念でした。" },
  { star: 5, name: "斎藤 健一", text: "名物の炭火焼きが最高でした！スタッフさんの接客も丁寧で、また絶対に来ます。" },
  { star: 4, name: "小林 まり", text: "料理は美味しいです。ただ人気店なので予約が取りづらいのだけが難点です。" },
];

console.log("① モック新着口コミを step1 エンジンでAI下書き生成中（実Groq）...\n");
const reviews = [];
for (const r of mockReviews) {
  const res = await generateReply({ review: r, business, providerConfig: { apiKey } });
  reviews.push({ star: r.star, name: r.name, text: r.text, draft: res.text });
  const flag = res.warnings.length ? ` ⚠️${res.warnings.join(",")}` : "";
  process.stderr.write(`  ★${r.star} ${r.name} -> 下書き ${res.text.length}字${flag}\n`);
}

console.log("\n② step2 でLINE日次ダイジェストを組む（dryRun=送信しない）...\n");
const out = await sendLineDigest({
  to: "Uxxxxxxxx(店主の個人LINE userId)",
  reviews,
  digest: { bizName: business.name, dashboardUrl: "https://meo-harness.example/dashboard" },
  dryRun: true,
});

console.log("── LINEに送られる本文プレビュー ───────────────");
console.log(out.payload.messages[0].text);
console.log("──────────────────────────────────────────────");
console.log(`\nメッセージ数: ${out.payload.messages.length}（=無料枠の消費1通）/ dryRun=${out.dryRun}`);
