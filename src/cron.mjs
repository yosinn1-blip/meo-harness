/**
 * 既存のバッファ配列に新しいレビューを追加する。
 * @param {Array|null} existing
 * @param {Array|null} incoming
 * @returns {Array}
 */
export function mergePendingReviews(existing, incoming) {
  return [...(existing ?? []), ...(incoming ?? [])];
}

/**
 * 店舗が daily-digest モードかどうか返す。
 * @param {{ notifyMode?: string }|null} store
 * @returns {boolean}
 */
export function shouldSendDigest(store) {
  return store?.notifyMode === 'daily-digest';
}

/**
 * 現在の UTC 時が店舗の「ダイジェスト送信時刻（現地 9:00）」かどうか返す。
 * @param {{ utcOffset?: number }|null} store  — utcOffset: -12〜+14 の整数（省略時 +9=JST）
 * @param {number} utcHour                     — 0〜23 の整数
 * @returns {boolean}
 */
export function isDigestHour(store, utcHour) {
  const offset = store?.utcOffset ?? 9;
  const localHour = ((utcHour + offset) % 24 + 24) % 24;
  return localHour === 9;
}
