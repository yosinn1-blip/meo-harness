# 自己登録版：承認後の本番接続準備

2026-09-27 11時台（JST）。直前に示した3点への「そちらで進めれるなら進めてください」を承認として実施。一般受付開始、実店舗接続、口コミ投稿、課金変更への包括承認とは扱っていない。

## 1. Google callback追加：保存確認済み

- project `yoshiki-apps-gbp`、既存OAuth client `yoshiki-apps-gbp-web` を使用。
- `https://meo-harness.yosinn1.workers.dev/api/self/google/callback` を4件目として追加。
- 既存のOAuth Playground、`http://localhost:4100/callback`、旧 `/gbp/oauth/callback` の3件を保持。
- Google Consoleの「OAuth クライアントを保存しました」を確認後、一覧から開き直し、4つのURIを再確認した。
- client secretは表示・変更していない。スコープやブランド設定、OAuth同意・Googleへの投稿も変更していない。
- 新しい本人ログインを開始せず、既存の認証済みChromeで管理設定のみを操作。CFTによる商品E2Eとは区別する。
- 証跡画像：`output/self-service/live-preparation/google-callback-saved.png`。URI欄だけの表示で、秘密値なし。

保存の確認であり、本番の新callbackへの実ログイン成功は未確認。本体の自己登録コードはまだデプロイしていない。

## 2. 共有LINE中継：本番反映・照合済み

- Worker: `gbp-notify-api`
- 対象コード: `gbp-notify-worker@33a1abd7fee81c566d838755a312c1f1cf2b86d0`
- 旧version: `e2d4fedf-8f93-4437-829c-1bbaa38502ec`
- 新version: `4f34e36e-d392-4832-96d0-269ac583884a`（100%）
- deployment: `f2617aab-f24c-4e68-9741-7e535fc85f03`
- 実行: 承認されたプロジェクト外Wrangler 4.81.1。対象account・Worker・configを固定、`--keep-vars`を付け、dry-run成功後に1回deploy。
- 反映後にAPIで稼働version、全binding、互換日を照合。KV、MEOへのservice binding、送信上限、Secret名/設定を保持した。
- アップロード済みモジュールのSHA-256は `476b485ba700e7c45f510654f351f8b9f4cfddc23cd7dce2a6b198093e793132`。デプロイ用ローカルbundleと一致し、新コード `MEOS-` を含むことも確認。
- 中継URLとMEO `/health` は200。
- LINEのWebhook URLを付け替えず、既存中継の処理だけ更新。実LINEメッセージは送っていない。本人端末への到達確認は別。

## 3. Turnstile：作成前で保留

- Cloudflare MCPは利用不可。承認済みWranglerの認証方式はOAuthで、列挙された権限にTurnstile Editはない。
- `turnstile-spin`の認証確認ヘルパーはAPIトークンを要求し、現在のOAuth資格情報はローカルの形式検査で `missing_token / invalid_token_format` となった。これはCloudflare APIの403ではなく、widget APIに到達する前の停止。
- ヘルパーには想定外にwidgetを作った際の自動DELETEがあるため、今回の確認ではその分岐を「手動確認を要求して停止」に置き換え、未承認削除を防いだ。実際には形式検査で停止しているため、widgetの作成・削除はどちらもない。
- 認証方式や権限を自動変更せず、別の認証経路への無断切り替えもしていない。
- ログイン済みCloudflare管理画面で同じ無料widget 1件を設定する方法への切り替え、または本人によるTurnstile限定API tokenの準備を質問中。秘密値をチャットへ貼り付けるよう求めていない。
- 対象は引き続き `meo-harness.yosinn1.workers.dev`、`localhost`、`127.0.0.1`。本番のSiteverifyは本番hostnameだけを照合し、actionは既存実装の `self_start`。
- widget作成、Secretの未デプロイ版への追加、実token成功・再利用拒否の検証は、今回はまだ行えていない。

[Cloudflareのwidget管理API](https://developers.cloudflare.com/turnstile/get-started/widget-management/api/)はTurnstile編集権限を要求する。管理画面を使う場合も、権限の問題を無断で迂回せず、今回質問した方法変更への回答後に行う。

## 変えていないもの・検証

- MEO本体の稼働version `5be5104e-1db4-410c-82ed-738947fa1fe1` とdeployment `0a09ca13-9199-43e8-8bf8-0b32ec7f8a49` は不変。
- 未デプロイの鍵入りversion `375501c3-1e54-4789-87ae-4f4551c65121` は保持し、鍵2つを再生成していない。D1も再作成・変更していない。
- 新コード、本番D1 binding、一般受付ON、規約/案内の公開、審査提出、実口コミ返信、課金変更は未実行。
- 今回再実行：MEO unit 207、relay unit 29が成功、fail/skip 0、元終了コード0。relayのdry-run/deployはいずれも終了0、反映後照合成功。
- runtime53/CFT12/署名付き跨repo統合は[直前の検証](self-service-launch-work-2026-09-27.md)の結果。今回の商品コードは追加変更しておらず、これらを再実行したとは扱わない。
- 外部実装委譲は、機密を伴う承認済みの基盤操作と短い記録作成のため省略。

証跡と1回実行markerは `output/self-service/live-preparation/`（Git対象外）に保存。deployスクリプトを盲目的に再実行しない。Wrangler資格情報はメモリ内で扱い、内部ログを `/dev/null` に向けて値を出力していない。

次はTurnstileの方法変更の回答を受け、その1件を準備。その後にも、案内とGoogle表示URLの整合、無料枠と既存分の確保、承認対象店での実接続・停止・切断、新MEO版公開・一般受付の承認が必要。
