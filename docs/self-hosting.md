# 自前運用を選ぶ場合

通常は共有サービスへ登録します。このページは自分でインフラを所有する方だけが対象です。AIに依頼すればGBP APIの承認やGoogleアプリ検証を省略できるわけではありません。

## 準備

- 自分のCloudflareアカウントとWorker、KV、D1。無料枠・課金設定は自分の現行アカウントで確認する。
- 自分のGBP API利用承認、Google OAuthクライアント、公開ドメインと `/api/self/google/callback` のredirect URI。`openid` と `https://www.googleapis.com/auth/business.manage` のみを使用。
- LINE Messaging APIのボット、署名Secretとチャネルアクセストークン。Webhook先は `/webhook/line-bot`。
- Groq APIとTurnstileのサイト設定。通常の利用者にはこれらを要求しない。

## ローカル確認

```sh
npm ci
npm test
npm run test:self-runtime
npm run build:self-test
npm run test:e2e
```

E2EはChrome for Testingを専用プロファイルで起動します。ブラウザ未導入の場合はPlaywrightのブラウザインストールを行ってください。`npm run preview:self-test` は架空環境のローカル画面確認専用で、外部プロバイダとは接続しません。フロー全体は `test:e2e` で実行します。本番情報をローカルtestへコピーしないでください。

## 設定の名前

公開設定: `SELF_PUBLIC_ORIGIN`、`SELF_REGISTRATION_ENABLED`、`SELF_PROCESSING_ENABLED`、`SELF_MAX_ACTIVE_STORES`、`SELF_MONTHLY_DRAFT_LIMIT`、`SELF_MONTHLY_PUSH_LIMIT`、`SELF_LEGACY_PUSH_RESERVE`、`SELF_TERMS_VERSION`、`TURNSTILE_SITE_KEY`、`SELF_LINE_FRIEND_URL`。

Secret管理: `SELF_TOKEN_KEY_V1`（32byteのランダム鍵をbase64化）、`SELF_RATE_KEY`、`TURNSTILE_SECRET_KEY`、`GBP_OAUTH_CLIENT_ID`、`GBP_OAUTH_CLIENT_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`GROQ_API_KEY`。

秘密の値はファイル・チャット・コミットへ貼らず、ホスティングのSecret管理で設定します。D1作成、migration適用、既存KV店舗のlocation予約、OAuth設定変更、デプロイ、受付ONは実施前に所有者の確認が必要です。保存済み資格情報を失わないよう、暗号鍵の変更は移行計画なしに行いません。

初期設定は受付・処理OFF、未設定の上限は0です。公開前に実際のプラン・残量、Googleアプリの検証状態、正式な利用条件・プライバシー表示を確認します。GBP API利用承認とOAuthアプリ検証は別です。詳細はリポジトリの `docs/self-service-release.md` を参照してください。
