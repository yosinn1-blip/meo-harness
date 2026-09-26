// 共有 LINE ボットでお店の通知先（lineUserId）を登録するための使い捨てコード。
// 形式は "MEO-" + 6文字。GBP Notify の登録コード（英数字ちょうど6文字）とは重ならない。
// 紛らわしい文字（0/O/1/I）は使わない。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE_RE = /^MEO-?([A-HJ-NP-Z2-9]{6})$/;

export const LINE_LINK_TTL = 24 * 3600;

export function makeLinkCode(randomValues = crypto.getRandomValues(new Uint8Array(6))) {
  return 'MEO-' + Array.from(randomValues, v => ALPHABET[v % ALPHABET.length]).join('');
}

// ユーザーが送ってきた文字列を正規化してコードを取り出す。コードでなければ null。
export function parseLinkCode(text) {
  const m = String(text ?? '').trim().toUpperCase().replace(/\s+/g, '').match(LINK_CODE_RE);
  return m ? `MEO-${m[1]}` : null;
}
