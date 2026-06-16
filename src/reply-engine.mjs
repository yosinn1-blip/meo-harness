// MEO Harness — 口コミ返信エンジン（本体Bの内部コア）
//
// 設計方針:
// - プロバイダ差し替え式（ハーネス思想）。既定 Groq＝無料・クレカ不要で超過課金が構造的に起きない。
//   品質オプションとして Gemini、ホスト同一無料枠の Workers AI に切替可能。
// - 純 fetch のみ使用 → Node（CLI/テスト）でも Cloudflare Workers（本番）でも同じコードで動く。
// - 返信は「下書き」のみ返す。投稿機能は持たない（ポリシー: 投稿前に必ずオーナー承認）。
// - Groq の稀な外国語文字混入を検出し、最大1回だけ再生成して吸収する。
//
// プロンプトは abtest.mjs / gen-demo-drafts.mjs で検証済みのものを集約（重複解消）。

export const PROVIDERS = Object.freeze({
  GROQ: "groq",
  GEMINI: "gemini",
  WORKERS_AI: "workers-ai",
});

export const DEFAULT_MODELS = Object.freeze({
  [PROVIDERS.GROQ]: "llama-3.3-70b-versatile",
  [PROVIDERS.GEMINI]: "gemini-2.5-flash", // 2.0系は無料枠0
  [PROVIDERS.WORKERS_AI]: "@cf/meta/llama-3.1-8b-instruct",
});

// 医療・治療系は薬機法/景表法に配慮し、効果保証の断定表現を禁じる一文を追加する。
const HEALTH_BIZ_RE = /整体|接骨|整骨|鍼灸|治療院|クリニック|歯科|医院|カイロ|エステ|サロン.*(脱毛|痩身)/;

export function isHealthBiz(bizType = "") {
  return HEALTH_BIZ_RE.test(bizType);
}

export function buildSystemPrompt({ bizType, bizName, health }) {
  const isHealth = health ?? isHealthBiz(bizType);
  const lines = [
    `あなたは${bizType}「${bizName}」のオーナーです。`,
    "Googleビジネスプロフィールに届いたお客様の口コミに対する返信を書いてください。",
    "",
    "【出力形式・厳守】",
    "- 出力は「返信本文」のみ。「下書き：」「返信の下書き:」などの前置き・見出しを一切付けない",
    "- （）やカッコ内の注釈・指示書き（例:「（確認してください）」）を出力に含めない",
    "- 名前のプレースホルダー（「〇〇様」「（お客様の名前）様」等）を使わない。お客様の名前は本文に与えられた場合のみ使い、無ければ名前を入れずに書く",
    "",
    "【内容のルール】",
    "- 日本語の口コミには日本語、英語の口コミには英語で返信する",
    "- 2〜4文で簡潔に。定型文の使い回しに見えないよう、口コミの具体的な内容に必ず触れる",
    "- 高評価には感謝を、不満には誠実な謝罪と改善・再来の意思を示す。決して言い訳・反論をしない",
    "- やっていないキャンペーン等の事実を捏造しない",
  ];
  if (isHealth) {
    lines.push("- 効果・治療・結果を保証する断定的な表現は避ける");
  }
  return lines.join("\n");
}

function buildUserPrompt(review) {
  const name = review.name ? `\n投稿者名: ${review.name}` : "";
  return `口コミ（星${review.star}）:${name}\n${review.text}`;
}

// ---- サニタイザ（決定的・テスト可能）-----------------------------------

const PREAMBLE_RE = /^\s*(返信(の下書き)?|下書き|Reply|Draft|回答)\s*[:：]\s*/i;
const HANGUL_RE = /[가-힣]/; // ハングル混入検出（Groqの既知の癖）
const PLACEHOLDER_RE = /[〇○◯]{1,3}様|（[^）]*(名前|お名前)[^）]*）様|\([^)]*(名前|お名前)[^)]*\)様/;

function stripWrappingQuotes(s) {
  const pairs = [
    ['"', '"'],
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of pairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > 2) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

/**
 * LLM出力を安全側に整える。破壊的変更は「安全な範囲（前置きラベル・囲みクォート除去）」に限定し、
 * それ以外（プレースホルダ・外国語混入・空）は warnings で通知して判断材料にする。
 * @returns {{ text: string, warnings: string[] }}
 */
export function sanitizeReply(raw) {
  const warnings = [];
  let text = (raw ?? "").trim();
  if (!text) {
    return { text: "", warnings: ["empty"] };
  }
  // 前置きラベル（例:「返信の下書き：」）を除去
  text = text.replace(PREAMBLE_RE, "").trim();
  // 全体を囲むクォートを除去
  text = stripWrappingQuotes(text);

  if (HANGUL_RE.test(text)) warnings.push("hangul-contamination");
  if (PLACEHOLDER_RE.test(text)) warnings.push("name-placeholder");
  if (text.length < 8) warnings.push("too-short");

  return { text, warnings };
}

// ---- プロバイダアダプタ -------------------------------------------------

async function callGroq({ system, user, model, apiKey, fetchImpl }) {
  const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
      max_tokens: 300,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Groq ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    tokens: data.usage?.total_tokens ?? 0,
  };
}

async function callGemini({ system, user, model, apiKey, fetchImpl }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim() ?? "";
  return { text, tokens: data.usageMetadata?.totalTokenCount ?? 0 };
}

// Workers AI は env.AI バインディング経由（Worker内でのみ動作）。
async function callWorkersAI({ system, user, model, ai }) {
  if (!ai || typeof ai.run !== "function") {
    throw new Error("Workers AI には env.AI バインディングが必要です（Node からは呼べません）");
  }
  const data = await ai.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.6,
    max_tokens: 300,
  });
  return { text: (data.response ?? "").trim(), tokens: 0 };
}

const ADAPTERS = {
  [PROVIDERS.GROQ]: callGroq,
  [PROVIDERS.GEMINI]: callGemini,
  [PROVIDERS.WORKERS_AI]: callWorkersAI,
};

/**
 * 口コミ1件から返信下書きを生成する。
 * @param {object} args
 * @param {{ star:number, text:string, name?:string }} args.review
 * @param {{ type:string, name:string, health?:boolean }} args.business
 * @param {string} [args.provider] PROVIDERS のいずれか（既定 groq）
 * @param {object} [args.providerConfig] { apiKey?, model?, ai? }
 * @param {function} [args.fetchImpl] テスト用に差し替え可能
 * @param {number} [args.maxRetries] 外国語混入時の再生成回数（既定1）
 * @returns {Promise<{ text:string, provider:string, model:string, tokens:number, ms:number, warnings:string[] }>}
 */
export async function generateReply({
  review,
  business,
  provider = PROVIDERS.GROQ,
  providerConfig = {},
  fetchImpl,
  maxRetries = 1,
}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`未知のプロバイダ: ${provider}`);

  const model = providerConfig.model ?? DEFAULT_MODELS[provider];
  const system = buildSystemPrompt({
    bizType: business.type,
    bizName: business.name,
    health: business.health,
  });
  const user = buildUserPrompt(review);
  const _fetch = fetchImpl ?? globalThis.fetch;

  const t0 = Date.now();
  let result;
  let warnings = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const out = await adapter({ system, user, model, apiKey: providerConfig.apiKey, ai: providerConfig.ai, fetchImpl: _fetch });
    const cleaned = sanitizeReply(out.text);
    result = { ...out, text: cleaned.text };
    warnings = cleaned.warnings;
    // 外国語混入・空のときだけ再生成。プレースホルダ等は警告のみで打ち切り。
    const shouldRetry = warnings.includes("hangul-contamination") || warnings.includes("empty");
    if (!shouldRetry) break;
  }

  return {
    text: result.text,
    provider,
    model,
    tokens: result.tokens ?? 0,
    ms: Date.now() - t0,
    warnings,
  };
}
