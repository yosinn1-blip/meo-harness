// 外部プラットフォームの Webhook ペイロードを共通フォーマットに正規化する
//
// 共通フォーマット:
//   { star: 1-5, text: string, name?: string, platform: string }

const GBP_STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/**
 * @param {'gbp' | 'yelp' | 'trustpilot'} platform
 * @param {object} raw — Webhook ペイロード（JSON.parse 済み）
 * @returns {{ star: number, text: string, name?: string, platform: string }}
 */
export function normalize(platform, raw) {
  switch (platform) {
    case 'gbp': return normalizeGbp(raw);
    case 'yelp': return normalizeYelp(raw);
    case 'trustpilot': return normalizeTrustpilot(raw);
    case 'yahoo-places': return normalizeYahooPlaces(raw);
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

function normalizeGbp(raw) {
  const starStr = raw?.starRating;
  const star = GBP_STARS[starStr];
  if (!star) throw new Error(`GBP: unknown starRating "${starStr}"`);
  return {
    star,
    text: raw?.comment ?? '',
    name: raw?.reviewer?.displayName,
    platform: 'gbp',
  };
}

function normalizeYelp(raw) {
  const data = raw?.data ?? raw;
  const star = Number(data?.rating);
  if (!Number.isInteger(star) || star < 1 || star > 5) {
    throw new Error(`Yelp: invalid rating "${data?.rating}"`);
  }
  return {
    star,
    text: data?.text ?? '',
    name: data?.user?.name,
    platform: 'yelp',
  };
}

function normalizeTrustpilot(raw) {
  const review = raw?.review ?? raw;
  const star = Number(review?.stars);
  if (!Number.isInteger(star) || star < 1 || star > 5) {
    throw new Error(`Trustpilot: invalid stars "${review?.stars}"`);
  }
  const text = [review?.title, review?.text].filter(Boolean).join('\n').trim();
  return {
    star,
    text,
    name: review?.consumer?.displayName,
    platform: 'trustpilot',
  };
}

// Yahoo!プレイス パートナー API Webhook または内部プッシュ形式を正規化する。
// event.review ラップあり・なし両方を受け付ける。
function normalizeYahooPlaces(raw) {
  const review = raw?.review ?? raw;
  const star = Number(review?.rating);
  if (!Number.isInteger(star) || star < 1 || star > 5) {
    throw new Error(`Yahoo!Places: invalid rating "${review?.rating}"`);
  }
  return {
    star,
    text: review?.comment ?? '',
    name: review?.userName,
    platform: 'yahoo-places',
  };
}
