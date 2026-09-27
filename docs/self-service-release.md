# 自己登録の公開前チェック

現在は **本番に画面・DB・Turnstileを反映済み、新規受付・処理OFF** です。2026-09-27の[Turnstile設定と実行環境修正の検証結果](self-service-turnstile-2026-09-27.md)を参照してください。Google同意画面の案内URLも保存済みです。実ブラウザで本人のGoogleログイン（openidのみ）成功を確認済みです。承認された[本人限定・1店舗の接続試験](self-service-owner-pilot-2026-09-27.md)を本番へ反映済みです。本人セッションからGoogleアカウント選択へ到達し、GBP権限の同意と接続対象店舗の確認を待っています。店舗接続・LINE・停止/切断はまだ実証していません。既存版の本番運用記録は、新しい自己登録機能の実接続の証拠ではありません。「記事から登録してすぐ使える」という告知は公開条件が揃った後に行います。以下の準備履歴には当時の未完了状態も含まれるため、現在状態はこの段落と最新の検証記録を優先してください。

2026-09-27の[本番読み取り確認と次の承認範囲](self-service-preflight-2026-09-27.md)も参照してください。既存の公開ポリシーと共有運用版の説明の食い違いは、一般受付前に解消が必要です。

その後、承認済みの[専用DBと未デプロイ版の鍵の準備](self-service-preparation-2026-09-27.md)まで実施しました。本番binding・新コードのデプロイ・一般受付は未実施です。[共有版の案内下書き](self-service-privacy-draft.md)も正式公開前です。

続く[Google・LINE・Groqの読み取り確認](self-service-provider-check-2026-09-27.md)で、自己登録用Google callbackの未登録、共有LINE中継の`MEOS-`非対応、Googleの検証未完了を確認しました。共有ボットでは、中継の対応を確認せずWebhookを本体へ付け替えないでください。

2026-09-27追記：共有LINE中継の `MEOS-` 対応をローカルで修正済み（relay `33a1abd`）。署名・本文を変更せず、本体と隔離D1まで通す検証も成功しました。実中継へのデプロイは承認待ちです。月別利用記録の保存期間と、同一オリジンの `/self/privacy`・`/self/terms` 案も実装しました。再登録でも同じGBP店舗のAI利用量を維持する修正と、孤立した利用者識別子の期限削除も追加しました。[最終修正・検証記録](self-service-launch-work-2026-09-27.md)を参照してください。これらのローカル確認で実接続・公開承認のgateをtrueにはしません。

2026-09-27 11時台追記：[本番準備の結果](self-service-live-preparation-2026-09-27.md)。承認後にGoogle callback追加と共有LINE中継の反映を確認しました。TurnstileはCLI認証が非対応のため、管理画面に切り替える方法への回答待ちです。本体の新コード・一般受付は引き続き未公開です。

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
  - 既存店のGBP店舗選択を変更する場合は、新しいlocationの予約を追加してからKVを保存する。旧locationの予約は自動解放しない。KV保存失敗・並行変更・処理中の旧口コミを考慮し、誤って自己登録側へ引き渡さないため。旧形式の予約も引き続き認識する。
  - 過去に選択したlocationを別の運用へ渡す必要がある場合は、現在のKV設定、旧pending/reply処理、通知・投稿中の処理がないことを確認し、対象を示して承認を得た運営作業で予約を解放する。自己登録の切断では既存店の予約を削除しない。
- LINE: 対象チャネルのWebhook URL/署名、残量、他用途の消費を確認。`SELF_LEGACY_PUSH_RESERVE`で既存分を確保。実残量不明や不足で送信は保留する。API受付と端末への到達は分けて確認。
- 表示/個人情報: 運営者、問い合わせ先、正式な条件版、認証/口コミ/下書きの保存目的を明示。ログにOAuth code、Cookie、登録code/PIN、本文、provider responseを出さない。D1のバックアップ/Time Travelと運用バックアップの保持期間はlive設定で確定する。
- 許可された店だけ実接続する。実返信の送信は、対象口コミと返信本文について本人が明示承認したときだけ。動作確認のために架空口コミを投稿しない。

D1作成、Secret追加、OAuth設定変更、migration、デプロイ、受付ONはこの文書があるだけでは承認されません。メインへの統合と公開も別操作です。

## 3. 安全な段階公開と停止

初期は`SELF_REGISTRATION_ENABLED=false`と`SELF_PROCESSING_ENABLED=false`。未設定/不正な利用上限は0扱いです。接続確認後に上限付きで受付を開きます。一般利用者へ管理APIキーを渡しません。

異常時は新規受付と新規処理をOFFにし、`/account`の既存利用者ログイン・停止・切断は残します。停止は開始済み外部HTTPを取り消すものではありません。タイムアウト後の投稿はGET照合し、返信がなければ本人による新しい承認を要求します。Googleで他の人が同時編集する競合を完全なトランザクションにすることはできません。

rollbackでD1・鍵・location予約を自動破棄しません。既存店舗のデータを保存し、原因と承認対象を確認してから復旧します。

## 失敗時の扱いと確認上の限界

- Google照合と投稿のDB更新にはleaseと状態照合を使い、古いGETが新しい投稿状態を戻さないようにします。
- LINEでは実際のquota観測と未反映・結果不明のローカル予約を、同じD1 transactionで予算へ反映します。重複の可能性を見込むため、残量を実際より少なく見積もって保留することがあります。別サービスが観測後に送る量やproviderの概数反映遅延を完全には予測できません。公開時には実残量・安全余裕を確認します。
- 一時的な未受付（429等）は、固定payload/retry keyのまま、新しい予算attemptで最大5回まで待ち時間を置いて再試行。結果不明の予約は再利用し、24時間後は自動再送しません。
- AI成功後の保存失敗は同じ本文のDB保存を最大3回試し、なお保存不能なら自動再生成を保留します。プロセス自体が失われた場合の外部APIとDBの完全なexactly-onceを保証しません。
- LINE操作の結果はreply APIで返し、push予算とは分離して計測します。reply token期限などで結果返信が届かなければaccount画面が確認先です。有料pushへの自動置換はしません。[LINE reply API](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)
