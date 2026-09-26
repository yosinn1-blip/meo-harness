# 自己登録の公開前チェック

現在は **隔離ブランチにローカル実装済み・一般公開前** です。既存版の本番運用記録は、新しい自己登録機能の実接続の証拠ではありません。美容院の試用日程とは独立に以下の公開条件を確認できます。「記事から登録してすぐ使える」という告知は公開条件が揃った後に行います。

## 1. ローカルで確認する

```sh
npm ci
npm test
npm run test:self-runtime
npm run build:self-test
npm run test:e2e
node scripts/check-self-release.mjs --evidence output/self-service/release-evidence.json
git diff --check
```

Nodeテスト、実D1エンジンの隔離テスト、Chrome for Testingの専用プロファイルを分けて検証します。E2EはGoogle/LINE/AIをすべて架空プロバイダへ差し替え、予想外の外部通信0件を要求します。架空口コミへのローカルPUT成功は実Googleへの投稿成功を意味しません。公開bundleにはfixture route、架空challenge、test用鍵、認証迂回を含めないことを確認します。

証跡は実行日時、対象commit、コマンド、件数、fail/skip、元終了コードだけを残し、秘密や本文は残しません。下記gateは明示的なbooleanのtrueだけを採用します。ファイルなし、false、不明はblocked（終了コード1）が正しい結果です。チェッカーは読取専用で、deployやSecret変更は行いません。

| 証跡の項目 | trueにできる根拠 |
|---|---|
| localTests | Node・D1・bundle・差分の検証が当該commitで成功 |
| browserStubE2E | 通信ゼロのCFT導線検証が成功 |
| oauthVerified | 運用対象Googleアプリの公開/検証状態、表示名、ドメイン、権限を実確認 |
| quotaChecked | LINE/Groq/Cloudflare/GBPの契約と実残量、自己登録上限、既存サービス用確保枠を確認 |
| liveConnection | 承認対象店でGoogle接続、店舗選択、LINE本人確認、口コミ取得を実確認 |
| liveStopVerified | 同じ環境で停止・切断、旧承認拒否、資格情報除去を実確認 |
| privacyReviewed | 正式な利用条件、連絡先、ログ除外、保存期間とバックアップ/復元保持期間を確認 |
| approvedRelease | 対象ドメイン、版、受付枠、外部変更の内容を示し公開承認を取得 |

## 2. 外部設定は対象を示して別途承認する

- Google: GBP API利用承認とは別に、OAuthアプリの表示名・検証済みドメイン・プライバシーURL・公開状態を確認。通常ログインは`openid`のみ、GBP接続は`openid`と`https://www.googleapis.com/auth/business.manage`。redirectは対象Workerと同じオリジンの`/api/self/google/callback`。
- Cloudflare: 対象アカウントとWorkerを確認してからD1を作成し、`migrations/0001_self_service.sql`を適用。`SELF_DB`にbinding。実Secretsと`.dev.vars`をビルド/テストへ流さない。
- 鍵: `SELF_TOKEN_KEY_V1`と`SELF_RATE_KEY`をSecret管理で生成・追加する。暗号鍵を勝手に回転/消去しない。復元時には同じ版の鍵を必要とする。
- 既存店: KV店舗一覧のGBP locationをD1の`location_claims`に先に予約し、重複・件数を確認。既存経路の新規作成にも同じ予約が適用される。既存稼働店を自己登録へ自動移行しない。
- LINE: 対象チャネルのWebhook URL/署名、残量、他用途の消費を確認。`SELF_LEGACY_PUSH_RESERVE`で既存分を確保。実残量不明や不足で送信は保留する。API受付と端末への到達は分けて確認。
- 表示/個人情報: 運営者、問い合わせ先、正式な条件版、認証/口コミ/下書きの保存目的を明示。ログにOAuth code、Cookie、登録code/PIN、本文、provider responseを出さない。D1のバックアップ/Time Travelと運用バックアップの保持期間はlive設定で確定する。
- 許可された店だけ実接続する。実返信の送信は、対象口コミと返信本文について本人が明示承認したときだけ。動作確認のために架空口コミを投稿しない。

D1作成、Secret追加、OAuth設定変更、migration、デプロイ、受付ONはこの文書があるだけでは承認されません。メインへの統合と公開も別操作です。

## 3. 安全な段階公開と停止

初期は`SELF_REGISTRATION_ENABLED=false`と`SELF_PROCESSING_ENABLED=false`。未設定/不正な利用上限は0扱いです。接続確認後に上限付きで受付を開きます。一般利用者へ管理APIキーを渡しません。

異常時は新規受付と新規処理をOFFにし、`/account`の既存利用者ログイン・停止・切断は残します。停止は開始済み外部HTTPを取り消すものではありません。タイムアウト後の投稿はGET照合し、返信がなければ本人による新しい承認を要求します。Googleで他の人が同時編集する競合を完全なトランザクションにすることはできません。

rollbackでD1・鍵・location予約を自動破棄しません。既存店舗のデータを保存し、原因と承認対象を確認してから復旧します。
