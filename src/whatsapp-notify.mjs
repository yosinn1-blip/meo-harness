// MEO Harness — WhatsApp Business Cloud API 通知モジュール
//
// WhatsApp「24時間ルール」:
//   相手からの最後のメッセージから24時間超 or 未会話 → template メッセージのみ送信可。
//   店主への口コミ通知はアウトバウンドなので常に template を使う。
//
// テンプレート一覧:
//   hello_world          (en_US)  Meta デフォルト。API 疎通確認用。
//   meo_harness_review   (ja)     本番用。Meta Business Manager で申請・承認後に使用可。
//
// ── meo_harness_review テンプレート仕様 ──────────────────────────────────────
// 申請日    : 2026-06-22
// Template ID: 1048897131176805（WABA ID: 1804833814203866）
// ステータス : PENDING（審査中）
// Category  : UTILITY
// Language  : ja
// Header    : MEO Harness 新着口コミ通知
// Body      : 【MEO Harness】{{1}}に新着口コミが{{2}}件届きました。
//             ダッシュボードで確認・返信承認をお願いします。
// Footer    : MEO Harness - 口コミ管理サービス
// Variables:
//   {{1}} → 店舗名（例: 山田カフェ）
//   {{2}} → 件数（例: 3）
// ─────────────────────────────────────────────────────────────────────────────
//
// 店舗 KV に追加するフィールド:
//   whatsappRecipient    — 店主の WhatsApp 番号（E.164、+なし。例: "819014479105"）
//   whatsappTemplateName — 使用テンプレート名（既定: "meo_harness_review"）
//   whatsappTemplateLang — 言語コード（既定: "ja"）
//
// Worker Secrets（wrangler secret put）:
//   WHATSAPP_TOKEN           — System User Token（Meta Business Manager）
//   WHATSAPP_PHONE_NUMBER_ID — 送信元電話番号 ID（例: "1222481350942430"）
//   WHATSAPP_VERIFY_TOKEN    — Webhook 検証トークン（任意の文字列）
//
// 呼び出し元（worker/index.mjs）で env から whatsappToken / whatsappPhoneNumberId を
// store オブジェクトに注入してから sendDigest を呼ぶこと。

const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';
const PRODUCTION_TEMPLATE = 'meo_harness_review';
const TEST_TEMPLATE = 'hello_world';

/**
 * WhatsApp テンプレートメッセージのペイロードを組み立てる。
 * @param {object} args
 * @param {string} args.to              宛先番号（E.164 +なし。例: "819014479105"）
 * @param {string} args.bizName         店舗名
 * @param {number} args.count           新着口コミ件数
 * @param {string} [args.templateName]  テンプレート名（既定: meo_harness_review）
 * @param {string} [args.templateLang]  言語コード（既定: ja）
 * @returns {object}
 */
export function buildWhatsAppPayload({ to, bizName, count, templateName, templateLang }) {
  const name = templateName ?? PRODUCTION_TEMPLATE;
  const lang = templateLang ?? 'ja';
  const isHelloWorld = name === TEST_TEMPLATE;

  const template = isHelloWorld
    ? { name, language: { code: 'en_US' } }
    : {
        name,
        language: { code: lang },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: String(bizName ?? '店舗') },
              { type: 'text', text: String(count ?? 1) },
            ],
          },
        ],
      };

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template,
  };
}

/**
 * WhatsApp でテンプレートメッセージを送信する。
 * @param {object} args
 * @param {string}  args.phoneNumberId  送信元電話番号 ID
 * @param {string}  args.token          WhatsApp アクセストークン
 * @param {string}  args.to             宛先番号（E.164 +なし）
 * @param {string}  args.bizName        店舗名
 * @param {number}  args.count          新着口コミ件数
 * @param {string}  [args.templateName]
 * @param {string}  [args.templateLang]
 * @param {boolean} [args.dryRun]       true なら API を叩かずペイロードを返す
 * @param {function}[args.fetchImpl]    テスト用に差し替え可能
 * @returns {Promise<{sent:number, messageId?:string, status?:string, payload?:object, dryRun?:boolean}>}
 */
export async function sendWhatsAppDigest({
  phoneNumberId,
  token,
  to,
  bizName,
  count,
  templateName,
  templateLang,
  dryRun = false,
  fetchImpl,
}) {
  if (!to) throw new Error('whatsappRecipient (to) が必要です');

  const payload = buildWhatsAppPayload({ to, bizName, count, templateName, templateLang });

  if (dryRun) return { dryRun: true, payload, sent: 0 };

  if (!token) throw new Error('WHATSAPP_TOKEN が必要です（dryRun=false 時）');
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID が必要です');

  const _fetch = fetchImpl ?? globalThis.fetch;
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;
  const res = await _fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
    const err = new Error(`WhatsApp ${res.status}: ${msg}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }

  return {
    sent: 1,
    messageId: data.messages?.[0]?.id,
    status: data.messages?.[0]?.message_status,
    payload,
  };
}

export const _internals = { GRAPH_API_BASE, PRODUCTION_TEMPLATE, TEST_TEMPLATE };
