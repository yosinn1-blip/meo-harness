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
