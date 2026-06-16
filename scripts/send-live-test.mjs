// step2 liveスモークテスト: モック口コミ → step1エンジン(実Groq)でAI下書き → step2で実LINE push送信
// 自分の個人LINE宛に1通だけ送る。無料枠(200通/月)を1通消費する。
// 実行: source ~/.config/ai-keys/load.sh && node scripts/send-live-test.mjs
import { generateReply } from "../src/reply-engine.mjs";
import { sendLineDigest } from "../src/line-notify.mjs";

const apiKey = process.env.GROQ_API_KEY;
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const to = process.env.LINE_USER_ID;

const missing = [];
if (!apiKey) missing.push("GROQ_API_KEY");
if (!channelAccessToken) missing.push("LINE_CHANNEL_ACCESS_TOKEN");
if (!to) missing.push("LINE_USER_ID");
if (missing.length) {
  console.error(`未設定: ${missing.join(", ")} （source ~/.config/ai-keys/load.sh を先に）`);
  process.exit(1);
}

const business = { type: "美容室", name: "MEO Harness テスト" };
const mockReviews = [
  { star: 5, name: "テスト 花子", text: "カットもカラーも丁寧で、仕上がりに大満足です。また通います！" },
  { star: 2, name: "テスト 太郎", text: "予約時間に行ったのに30分待たされました。技術は良かったので惜しいです。" },
];

console.log("① モック新着口コミを step1 エンジンでAI下書き生成中（実Groq）...\n");
const reviews = [];
for (const r of mockReviews) {
  const res = await generateReply({ review: r, business, providerConfig: { apiKey } });
  reviews.push({ star: r.star, name: r.name, text: r.text, draft: res.text });
  const flag = res.warnings.length ? ` ⚠️${res.warnings.join(",")}` : "";
  process.stderr.write(`  ★${r.star} ${r.name} -> 下書き ${res.text.length}字${flag}\n`);
}

console.log("\n② step2 で実LINE pushを送信（dryRun=false / 無料枠を1通消費）...\n");
try {
  const out = await sendLineDigest({
    channelAccessToken,
    to,
    reviews,
    digest: { bizName: business.name, dashboardUrl: "https://yosinn1-blip.github.io/yoshiki-apps/demo.html" },
    dryRun: false,
  });
  console.log(`✅ 送信成功: sent=${out.sent}（あなたの個人LINEを確認してください）`);
} catch (e) {
  console.error(`❌ 送信失敗: ${e.message}`);
  if (e.status === 400) {
    console.error("  → 400の典型原因: botをまだ友だち追加していない/ブロック中。");
    console.error("    LINEで @477byprh を検索 or QRで友だち追加してから再実行してください。");
  }
  process.exit(1);
}
