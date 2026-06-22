#!/usr/bin/env node
// salon-scout.mjs
// Usage: source ~/.config/ai-keys/load.sh && node scripts/salon-scout.mjs
// 出力: scripts/scout-cache/<日時>-places-raw.json  … Places API 生レスポンス
//       scripts/scout-cache/<日時>-serp-raw.json    … SerpAPI 生レスポンス（store_id→data）
//       scripts/scout-cache/<日時>-results.json     … 最終スコア済みリスト

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "scout-cache");
mkdirSync(CACHE_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const save = (label, data) => {
  const file = join(CACHE_DIR, `${RUN_ID}-${label}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  → 保存: scout-cache/${RUN_ID}-${label}.json`);
};

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const SERP_KEY   = process.env.SERPAPI_KEY;

if (!GOOGLE_KEY) {
  console.error("GOOGLE_API_KEY が未設定です");
  process.exit(1);
}
if (!SERP_KEY) {
  console.error("SERPAPI_KEY が未設定です");
  process.exit(1);
}

const LAT    = 34.6690; // 大阪市浪速区幸町1丁目付近（clomusと同じ丁目）
const LNG    = 135.4946;
const RADIUS = 1000;

// Nearby検索の上位60件から弾かれても必ずチェックしたい店舗（place_idで指定）
const PINNED_PLACE_IDS = [
  "ChIJsWFSUcjnAGAR_3EfvK-Z7_I", // clomus（幸町）
];

const EXCLUDE_KEYWORDS = ["女性専用", "レディース", "ladies", "ウィメンズ", "レディ"];
const MENS_KEYWORDS    = ["メンズ", "men", "男性", "理容", "barber"];
const HAIR_KEYWORDS    = ["美容", "ヘア", "hair", "理容", "床屋", "カット", "サロン", "salon", "barber", "cut"];

// ① 近隣店舗一覧を取得（beauty_salon + hair_care を並列検索してマージ）
async function fetchPagesByType(type, pageToken) {
  const params = new URLSearchParams({
    location: `${LAT},${LNG}`,
    radius: RADIUS,
    type,
    language: "ja",
    key: GOOGLE_KEY,
  });
  if (pageToken) params.set("pagetoken", pageToken);
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`);
  return res.json();
}

async function fetchByType(type) {
  const places = [];
  let pageToken = null;
  for (let page = 0; page < 3; page++) {
    const data = await fetchPagesByType(type, pageToken);
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error(`Places APIエラー(${type}):`, data.status, data.error_message || "");
      break;
    }
    if (data.results) places.push(...data.results);
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
    await new Promise(r => setTimeout(r, 2000));
  }
  return places;
}

async function fetchPlaceDetail(placeId) {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: "place_id,name,vicinity,rating,user_ratings_total,geometry,types",
    language: "ja",
    key: GOOGLE_KEY,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params}`);
  const data = await res.json();
  return data.result ?? null;
}

async function fetchAllPlaces() {
  // beauty_salon と hair_care を並列取得して place_id で重複除去
  const [beauty, hair] = await Promise.all([
    fetchByType("beauty_salon"),
    fetchByType("hair_care"),
  ]);
  const seen = new Set();
  const merged = [];
  for (const p of [...beauty, ...hair]) {
    if (!seen.has(p.place_id)) { seen.add(p.place_id); merged.push(p); }
  }
  // ピン留め店舗をマージ（Nearby検索で弾かれても必ず含める）
  for (const id of PINNED_PLACE_IDS) {
    if (!seen.has(id)) {
      const detail = await fetchPlaceDetail(id);
      if (detail) { seen.add(id); merged.push(detail); console.log(`  📌 ピン追加: ${detail.name}`); }
    }
  }
  return merged;
}

// ② SerpAPIで口コミ返信データを取得
async function fetchReplyData(placeId) {
  const params = new URLSearchParams({
    engine: "google_maps_reviews",
    place_id: placeId,
    hl: "ja",
    api_key: SERP_KEY,
  });
  try {
    const res = await fetch(`https://serpapi.com/search?${params}`);
    const data = await res.json();
    if (!data.reviews || data.error) return null;

    const total = data.reviews.length;
    const withReply = data.reviews.filter(r => r.response).length;
    const lastReply = data.reviews
      .filter(r => r.response)
      .map(r => r.response.date)
      .filter(Boolean)
      .sort()
      .pop();

    return { total, withReply, replyRate: total > 0 ? Math.round((withReply / total) * 100) : 0, lastReply };
  } catch {
    return null;
  }
}

// ③ スコアリング
function scorePlace(place) {
  const name     = (place.name || "").toLowerCase();
  const vicinity = (place.vicinity || "").toLowerCase();

  for (const kw of EXCLUDE_KEYWORDS) {
    if (name.includes(kw.toLowerCase()) || vicinity.includes(kw.toLowerCase())) return null;
  }

  let score = 0;

  for (const kw of MENS_KEYWORDS) {
    if (name.includes(kw.toLowerCase())) { score += 20; break; }
  }

  const count = place.user_ratings_total || 0;
  if      (count >= 100) score += 30;
  else if (count >=  50) score += 20;
  else if (count >=  30) score += 10;
  else if (count <    5) score -= 20;

  const rating = place.rating || 0;
  if      (rating >= 4.0 && rating <= 4.6) score += 20;
  else if (rating >= 4.7)                  score +=  5;
  else if (rating <  3.5)                  score -= 10;

  return score;
}

function replyScoreBonus(replyData) {
  if (!replyData) return 0;
  // 返信実績あり・かつ最近止まっているほど高スコア
  if (replyData.withReply > 0 && replyData.replyRate < 80) return 30;
  if (replyData.withReply > 0 && replyData.replyRate >= 80) return 5;
  if (replyData.withReply === 0) return -10;
  return 0;
}

async function main() {
  console.log("近隣の美容院・サロンを検索中...\n");

  const allPlaces = await fetchAllPlaces();
  save("places-raw", allPlaces);
  console.log(`${allPlaces.length}件の店舗を発見\n`);

  const pinnedSet = new Set(PINNED_PLACE_IDS);
  const prescored = allPlaces
    .map(p => ({ ...p, score: scorePlace(p) }))
    .filter(p => p.score !== null)
    .sort((a, b) => {
      // ピン留め店舗は常に先頭に
      const ap = pinnedSet.has(a.place_id) ? 1 : 0;
      const bp = pinnedSet.has(b.place_id) ? 1 : 0;
      return (bp - ap) || (b.score - a.score);
    })
    .slice(0, 15 + PINNED_PLACE_IDS.length); // ピン数分だけ枠を追加

  console.log(`上位${prescored.length}件の返信状況を確認中...\n`);

  const results = [];
  const serpRaw = {};
  for (const p of prescored) {
    process.stdout.write(`  チェック中: ${p.name} ... `);
    const replyData = await fetchReplyData(p.place_id);
    serpRaw[p.place_id] = { name: p.name, replyData };
    const bonus = replyScoreBonus(replyData);
    results.push({ ...p, replyData, finalScore: p.score + bonus });
    const status = replyData
      ? `返信率${replyData.replyRate}% (${replyData.withReply}/${replyData.total}件)`
      : "取得失敗";
    console.log(status);
    await new Promise(r => setTimeout(r, 500));
  }
  save("serp-raw", serpRaw);

  results.sort((a, b) => b.finalScore - a.finalScore);
  save("results", results);

  const isHair = p => HAIR_KEYWORDS.some(kw => (p.name || "").toLowerCase().includes(kw.toLowerCase()));

  const printPlace = (p, i) => {
    const isMens = MENS_KEYWORDS.some(kw => (p.name || "").toLowerCase().includes(kw));
    const mensFlag = isMens ? " [mens]" : "";
    const maps = `https://www.google.com/maps/place/?q=place_id:${p.place_id}`;
    const rd = p.replyData;
    const replyStr = rd
      ? `返信率: ${rd.replyRate}% (${rd.withReply}/${rd.total}件)${rd.lastReply ? " / 最終返信: " + rd.lastReply : ""}`
      : "返信データ取得不可";

    console.log(`${i + 1}. ${p.name}${mensFlag}`);
    console.log(`   評価: ${p.rating ?? "なし"} / 口コミ数: ${p.user_ratings_total ?? 0}件 / スコア: ${p.finalScore}`);
    console.log(`   ${replyStr}`);
    console.log(`   場所: ${p.vicinity}`);
    console.log(`   マップ: ${maps}`);
    console.log();
  };

  const hairResults  = results.filter(isHair);
  const otherResults = results.filter(p => !isHair(p));

  console.log("\n=== ヘアサロン・理容院（優先候補）===\n");
  hairResults.forEach(printPlace);

  console.log("=== その他美容系（参考）===\n");
  otherResults.forEach(printPlace);

  console.log("-- 判断基準 --");
  console.log("返信率0%: 返信に興味なし → スキップ");
  console.log("返信率1-70%: 手が回っていない → 最優先でアプローチ");
  console.log("返信率80%以上: すでに対応できている可能性 → 慎重に判断");
}

main().catch(console.error);
