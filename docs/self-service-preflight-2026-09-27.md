# 自己登録版：公開前の読み取り確認

確認日: 2026-09-27（JST）。対象コード: `6b04115`。この文書は確認記録と承認依頼の範囲であり、公開・外部変更の承認ではありません。

## 確認できたこと

| 対象 | 読み取り結果 |
|---|---|
| ローカル | `main`はclean。商品コードは直前に統合・検証した版から変更なし |
| 対象サービス | Worker `meo-harness`、`https://meo-harness.yosinn1.workers.dev` |
| 稼働確認 | `/health`は200。`/start`・`/account`・`/api/self/status`は404。自己登録画面はまだ本番に出ていない |
| 現行デプロイ | `5be5104e-1db4-410c-82ed-738947fa1fe1`に100%。作成時刻は2026-09-27 04:08:45 JST |
| Cloudflare | 現在認証されているアカウントは1件。対象の既存WorkerとKV bindingを確認 |
| 本番binding | `STORES`は存在。`SELF_DB`と`SELF_*`設定は現行版に存在しない |
| Secret名だけの確認 | Google OAuth・LINE・Groqの既存Secret名は存在。`SELF_TOKEN_KEY_V1`・`SELF_RATE_KEY`・`TURNSTILE_SECRET_KEY`は未登録。値や有効性は確認していない |
| D1一覧 | `meo`を含む名称のDBなし。別名DBの用途は確認していないため、専用DBが絶対に存在しないとは断定しない |
| Google CLI | 認証済みアカウント1件、既定projectは`sub-detector`。MEOのOAuthクライアントとの対応は未照合。既定projectを推測で変更しない |
| 公開ポリシー | 現行の`privacy.html`をHTTP 200で取得し、ローカル版とSHA-256一致。共有運用版と説明が食い違う |

Cloudflareは公式Wranglerの読み取りコマンド（whoami、deployments list、versions view、secret list、d1 list）だけを実行しました。Secretの値・既存店舗レコード・認証ファイルを直接読み出していません。認証開始や設定保存も行っていません。

## 公開案内に必要な修正

現行の[プライバシーポリシー](https://yosinn1-blip.github.io/yoshiki-apps/privacy.html)は、セルフホストのみ、運営側で店舗データを蓄積しない、利用者自身のAIキーを使う、という説明です。新しい共有サービスの保存・処理実態とは一致しません。

修正方針（事実関係の差分案であり、正式な規約・ポリシーの確定ではありません）:

- 共有サービスとセルフホストを区別し、共有版では運営側CloudflareのD1に店舗・認証・口コミ・返信案を保存することを明記する。
- 共有版は運営側のGroq/LINE接続を利用し、通常利用者に自分のAPIキーを要求しないことを明記する。
- Google認証情報の暗号化、未完了接続24時間・本文7日・操作記録30日の通常保持、停止と切断の違いを説明する。
- バックアップの保持期間は実プランと設定を確認してから確定する。切断時の通常DB削除を、バックアップも即時消去されるという説明にしない。
- 運営者・問い合わせ先・正式な条件の版を確認し、登録時の案内から参照できるようにする。

`yoshiki-apps`の既存未コミット変更（導入案内2ファイルとtests）は触っていません。公開ポリシーも未変更です。

## 次に承認を求める最小の外部変更

対象は上記と同じCloudflareアカウントの`meo-harness`だけ。先に実プラン・料金条件を読み取り、追加購入やプラン変更が必要なら実行せず確認します。

1. 新しい専用D1 `meo-harness-self-service`を作成し、その空DBに限って`migrations/0001_self_service.sql`を適用する。既存DB/KVは変更しない。
2. 自己登録用の新規鍵2つ（`SELF_TOKEN_KEY_V1`・`SELF_RATE_KEY`）を生成し、**未デプロイのWorker version**へ追加する。既存鍵は置換・回転しない。秘密の値をチャット・ログ・Gitに出さない。
3. 前後で現行デプロイIDと`/health`を確認し、本番への配信が変わっていないことを確認する。

通常の`wrangler secret put`は即時デプロイを伴うため、この準備では使用しません。未デプロイversionへの追加は[CloudflareのSecrets手順](https://developers.cloudflare.com/workers/configuration/secrets/#adding-secrets-to-your-project)に従い、実行前にローカルWranglerの対応を再確認します。

この承認範囲に、新コードのデプロイ、一般受付ON、Google OAuth設定変更、Turnstileサイト作成、店舗接続、LINE実送信、Googleへの返信、ポリシー公開、既存データの削除は含めません。

## その後に残る確認

- OAuthの対象project/client、redirect URI、表示名、公開/検証状態。
- LINE/Groq/GBP/Cloudflareの実残量・上限、Turnstile、既存店用の確保枠。
- 既存KV店舗のlocation予約と重複防止。既存店は自動移行しない。
- ポリシーと条件、バックアップ保持期間、限定試用の対象店。
- 承認した店での接続・停止・切断確認。口コミ返信は対象本文ごとの別承認。

現時点の公開gateは、OAuth・利用枠・実接続・実停止・privacy・公開承認の6条件でblocked（終了1）のままです。前ターンのローカル235件成功と、実店舗で使えることは分けて扱います。

## 証跡

秘密や店舗本文を含まない読み取り結果は`output/self-service/preflight/`に保存（Git対象外）。公開ルートのHTTP状態、稼働version、Secret名、対象D1候補、公開ポリシーのハッシュ等です。今回、商品コードの変更・外部書き込み・送信・公開はありません。外部委譲は調査と短い文書作成のみのため省略しました。
