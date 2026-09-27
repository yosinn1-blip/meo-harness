# 自己登録版：Google・LINE・Groqの接続準備確認

確認日: 2026-09-27 10:17–10:30 JST。ローカルMEO `main`の基準は`eef1634`、共有LINE中継は`gbp-notify-worker@8ec9144`。これは読み取り結果と修正案の記録であり、外部設定変更・公開の承認ではありません。

## 結論

DBと鍵の準備は[前回の記録](self-service-preparation-2026-09-27.md)どおり完了済み。今回はそれらを再作成していません。一般登録の公開前に、少なくとも次の接続上の問題を解消する必要があります。

1. Googleの自己登録用callbackがOAuthクライアントに未登録。
2. 共有LINE中継が新しい`MEOS-`コードを転送しない。
3. Googleのブランディングとデータアクセスの検証が未完了。

本番デプロイ、OAuth保存、Webhook変更、実メッセージ送信、AI生成リクエスト、課金変更は行っていません。

## Google

- Keychainの`GBP_OAUTH_CLIENT_ID`は、現在のConsoleの`yoshiki-apps-gbp-web`と一致。所属projectは`yoshiki-apps-gbp`（`7056020553`）。Secret値は記録していません。本番Worker内のSecretとの値比較はしていません。
- 公開ステータスは**本番環境／外部**。検証センターは**ブランディング未表示、データアクセス未検証**。本番ステータスだけを「審査済み」と扱わない。
- Console表示のOAuthユーザーは**1人／累計上限100人**。確認前の機密スコープに対する上限で、店舗数の上限や毎月リセットされる枠ではない。
- Data Accessでは`business.manage`は**非機密**欄、旧`gmail.readonly`は**制限付き・未検証**欄にある。新しい自己登録コードが要求するのは`openid`と`business.manage`だけで、Gmailは要求していない。したがって、画面の未検証表示だけから「GBPにGmail相当の審査が必要」「新規店舗が必ず100店で止まる」とは判断しない。旧Gmail用途が他に残っていないか確認し、承認後に不要scopeを整理してブランド確認と分離する。[Googleの検証要件](https://support.google.com/cloud/answer/13464321?hl=en)
- アプリ名は`Yoshiki Apps GBP Manager`。ホームページとprivacy URLは既存の`yosinn1-blip.github.io/yoshiki-apps`。利用規約URLは空。承認済みドメイン欄には`yosinn1-blip.github.io`と`yosinn1.workers.dev`があるが、これだけでブランド検証済みとはしない。
- 登録済みredirectはOAuth Playground、`http://localhost:4100/callback`、既存の`https://meo-harness.yosinn1.workers.dev/gbp/oauth/callback`の3件。新しい`https://meo-harness.yosinn1.workers.dev/api/self/google/callback`は未登録。既存3件を消さずに1件追加するのが最小変更案（未実行・承認が必要）。
- GBPの口コミ、アカウント管理、店舗情報APIは有効。Service Usageの読み取りAPIで以下のeffective limitを確認。実使用量や瞬間残量ではない。

| API / quota metric | effective limit |
|---|---|
| My Business `default_requests` | 600/分、250,000/日 |
| My Business `default_update_requests` | 300/分、10,000/日 |
| My Business `default_v4_requests` | 3,000/分 |
| Account Management `default_requests` | 300/分 |
| Business Information `default_requests` | 300/分 |

API有効化・quota付与は、OAuthブランド審査や実店舗の接続成功を代替しません。[Google Auth Platform](https://support.google.com/cloud/answer/15544987)、[quota読み取りAPI](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1beta1/services.consumerQuotaMetrics/list)を参照。

## 共有LINEボット

- KeychainのアクセストークンでGETのみ実施。対象は`MEO Harness 通知`、公開ID`@477byprh`。
- Webhookは`https://gbp-notify-api.yosinn1.workers.dev/webhook/line`、有効。これは誤設定と断定しない。既存サービスと共有し、`MEO_HARNESS`のservice bindingで本体へ転送する設計がローカルの中継repoと過去記録にある。
- 月間quotaは`limited: 200`、使用量APIの概数は`7`。単純差は193だが、反映遅延・他用途の送信・予約分を含む正確な残量ではない。既存店用の確保枠を別途決める必要がある。[LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/)
- 中継`isForMeoHarness`の現在コードを実行して、旧`MEO-ABC234`は転送対象、新`MEOS-ABCDEFGH2345`は対象外、`approve:ss_fixture`は対象と確認。
- 自己登録本体は`MEOS-`＋12文字を発行する。**中継との形式不一致で、新しいLINE本人確認が始まらない**。

### 中継の最小修正案（この確認時点では未実装）

`/Users/yoshiki/dev/gbp-notify-worker/src/index.js`の転送条件に、自己登録本体と同じ`^MEOS-[A-HJ-NP-Z2-9]{12}$`を追加する。旧コードと承認postbackは維持。本文・署名を加工せず、既存service bindingを使う。Webhook先を直接MEOへ変更してGBP Notifyの経路を壊さない。

テストは新コードの転送、本文・署名維持、不正署名の拒否、旧コード／GBP Notifyの6桁コード／自己登録の承認postbackの回帰を確認する。実チャネルへ模擬イベントは送らない。ローカル修正の了承を質問済みで、承認前に本体・中継のコードは変更していない。

## Groq

ログイン済みConsoleの`Personal / Default Project`を読み取り。既存タブが別ブラウザセッションで使用中だったため、自分の調査用タブを作成。新規ログインや認証コード取得はしていません。製品E2Eとは異なる管理画面の読み取りなので、認証済みChromeを使用しました。

- BillingのCurrent Planは**Free**。Usageの金額は有料契約時の換算額という注記があり、実請求と扱わない。
- 現行モデル`qwen/qwen3.8-27b`の組織枠は**30 request/分、1,000 request/日、8,000 token/分、200,000 token/日**。APIキーの所属と本番WorkerのSecretとの一致、project別override、正確な日次残量は未確認。別用途の使用があるため、全量をMEO用とはしない。
- Data Controlsの**Global ZDRとInference APIs ZDRはいずれもDisabled**。設定は変更していない。
- [Groqの公式データ保持説明](https://console.groq.com/docs/your-data)は、通常の推論本文は原則保持しない一方、障害対応・不正利用調査等では最長30日の保持（法令上の例外あり）を説明している。未変更の現状を「完全無保存」と案内しない。
- Inference APIs ZDRだけをONにする案は、Batch等を巻き込むGlobal ZDRより範囲が狭い。ただし同組織の他用途にも影響するため、設定変更前に対象範囲を示して承認を取る。今回ONにしていない。

## 公開前の順序と残り

1. ローカルで共有LINE中継の形式不一致を修正し、署名付きfixtureで検証。
2. 正式なprivacy／条件／運営者・連絡先を確定。Groqの保持設定、利用量記録の保存期間、暗号鍵の復旧運用を詰める。
3. 承認後、Google callback追加、不要な旧Gmail scopeの整理、必要なGroqデータ制御、Turnstile等を準備。不要なGmail権限の審査へ進めず、ブランド確認と必要scopeの要件を分ける。OAuth審査の提出・公開操作は別途承認。
4. 未デプロイ版の追加済み鍵を保全し、DB bindingと既存location予約を含めて新コードを準備。今回の鍵を再生成しない。
5. 承認された限定店でGoogle接続→LINE本人確認→停止・切断を実確認。実返信は対象口コミと本文を示した別承認後だけ。
6. 実残量と安全余裕から受付数を決め、一般受付・記事公開を判断する。

今回の確認だけでは`oauthVerified`、`quotaChecked`、`privacyReviewed`をtrueにしません。既存の6つの公開gateは未充足のままです。新しい共有LINEの問題とcallback未登録も、実接続前に解消すべき具体的な阻害要因として追加しました。

## 今回の検証結果

- MEOの`npm test`: **179 pass、0 fail、0 skip、終了0**。
- 共有LINE中継の既存`npm test`: **24 pass、0 fail、0 skip、終了0**。既存テストには新しい`MEOS-`転送がなく、この成功を新導線の合格と扱わない。独立した関数実行では新コードの転送漏れを再現した。
- 公開gate: 既存6条件で**終了1（意図した公開保留）**。
- 10:31 JSTの公開HTTP確認: `/health`=200、`/start`=404、`/account`=404。
- 今回の変更はMEOの記録文書のみ。runtime／CFT E2Eはこの読み取り調査では再実行していない。両サービスの実装・本番設定・外部送信は未変更。

読み取り証跡は`output/self-service/provider-preflight/`（Git対象外）。認証情報はメモリ内で公式providerへだけ渡し、値をログ・ファイル・コミットへ書いていません。今回は調査・文書作成のみで、外部実装委譲は行っていません。
