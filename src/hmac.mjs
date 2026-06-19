// HMAC-SHA256 による Webhook 署名検証
// crypto.subtle は Cloudflare Workers・Node.js v19+ で利用可能

const enc = new TextEncoder();

/**
 * @param {string} secret       — 店舗ごとの webhookSecret
 * @param {string} body         — 受信した生 HTTP ボディ文字列
 * @param {string} signature    — X-Webhook-Secret ヘッダの値（hex）
 * @returns {Promise<boolean>}
 */
export async function verifyHmac(secret, body, signature) {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = toHex(new Uint8Array(mac));

  return timingSafeEqual(expected, signature.toLowerCase());
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
