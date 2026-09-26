# MEO Harness（仮称）

> Googleビジネスプロフィール（GBP）に届いた口コミへの返信を、**AIの下書き＋LINEで承認**で回すオープンソースの店舗ツール。
> Cloudflare Workers の無料枠で動きます。

![MEO Harness デモ：業種を選ぶと、その店の口コミにAIが返信下書きを出す](https://yosinn1-blip.github.io/yoshiki-apps/assets/meo-harness-demo.gif)

**▶ 触れるデモ（登録不要・架空店舗）: https://yosinn1-blip.github.io/yoshiki-apps/demo.html**

**現ステータス（2026-09-27）**: 試験運用中。GBP API の利用承認を取得し、口コミ取得 → AI下書き → LINE承認 → Google へ返信投稿の流れを本番環境で通しテスト済み。実店舗での利用はこれから。

## できること

- **新着口コミの取得** — GBP 公式 API（`mybusiness.googleapis.com/v4` の reviews）を1時間ごとに確認
- **AIの返信下書き** — Groq（`qwen/qwen3.8-27b`・無料枠）。下書きエンジン（`src/reply-engine.mjs`）は Gemini / Cloudflare Workers AI にも対応（Worker からの切り替えは未実装）
- **LINE 通知と承認** — 口コミと返信案が LINE に届き、「承認して送信」を押すと Google に返信を投稿。投稿の成否も LINE に返る
- **まとめ通知** — 即時通知のほか、1日1回のダイジェストにもできる
- **ほかの口コミ元** — Webhook 経由で他サービスの口コミも同じ流れに載せられる（AI下書き＋通知まで）

## まだ無いもの

- 投稿（最新情報）の予約・繰り返し投稿
- インサイト（表示回数・電話・経路検索）の蓄積と分析
- 写真・Q&A の管理
- 店舗の人が自分だけで始められる登録画面（今は管理者が一緒に設定する）

## やらないこと（ポリシー）

- ❌ 検索順位のスクレイピング・推測（公式 API に順位は無く、スクレイピングは Google の規約違反のため）
- ❌ 虚偽の口コミ生成・報酬付きの口コミ依頼（景品表示法のステルスマーケティング規制・Google のポリシー違反のため）
- ❌ AI 返信の無断投稿（**投稿前に必ずオーナーが LINE で承認**する）

## しくみ

```
毎時 cron ─▶ GBP API で新着口コミを取得 ─▶ AI が返信下書き ─▶ LINE に通知（承認ボタン付き）
                                                                      │
                               Google に返信を投稿 ◀── オーナーが「承認して送信」
```

- **Cloudflare Workers + KV + cron**（`worker/index.mjs`）
- **LINE Messaging API** — 通知と承認ボタン。店舗の人はボットを友だち追加して登録コード（`MEO-XXXXXX`）を送るだけで通知先に登録される
- **GBP 公式 API** — OAuth（`business.manage`）で店舗オーナーが許可。店舗が1つなら自動で選択

## 店舗をつなぐ流れ（試験運用中の手順）

管理用エンドポイントは `X-Admin-Key` が必要です。

1. `PUT /admin/stores/:storeId` — 店舗を登録（`apiKey`・`businessName`・`businessType`）
2. `POST /admin/stores/:storeId/line/link-code` — LINE 登録コードを発行（24時間・使い捨て）→ 店舗の人がボットに送る
3. `POST /admin/stores/:storeId/gbp/oauth/start` — Google 接続 URL を発行（10分有効）→ 店舗の人が許可
4. `GET /admin/stores/:storeId/status` — 接続を確認（店舗が複数なら `PUT /admin/stores/:storeId/gbp/location` で選ぶ）

## 自分で動かす場合の注意

コードは MIT で自由に使えますが、自前で運用するには **自分の Google Cloud プロジェクトで GBP API の利用申請と承認** が必要です（GBP のオーナー確認から一定期間が必要で、審査もあります）。承認前のプロジェクトは API の割り当てが 0 です。

## 開発

```bash
npm test          # node --test
npx wrangler dev  # ローカル実行
```

必要な Worker Secrets は `worker/index.mjs` 冒頭のコメントを参照してください。

## License

MIT

---

Google、Google ビジネスプロフィールは Google LLC の商標です。本プロジェクトは Google と提携・後援関係にありません。
