# Turnstile本番設定と実行環境の不具合修正

## 現在の状態

2026-09-27、本人のCloudflareログイン後に承認済みの管理画面方式で設定を継続した。一般受付と処理はOFF、新規店舗・下書き・push上限は0のまま。記事の公開条件はまだ満たしていない。

- 無料のManaged widget `MEO Harness self-service` を1個作成。sitekeyは `0x4AAAAAAFE6uTVTTIAlwcWr`。
- ホストは `meo-harness.yosinn1.workers.dev`、`localhost`、`127.0.0.1` の3件。pre-clearanceはOFF。管理画面の一覧でも3ホスト・Managed・No pre-clearanceを確認した。
- 新規secretを標準の `wrangler versions secret put TURNSTILE_SECRET_KEY` で既存Worker `meo-harness` の未配信版へ保存。CLIは承認済み `/opt/homebrew/lib/node_modules/wrangler/bin/wrangler.js`、4.81.1。直前に同一対象のsecret listを確認。値はメモリと標準入力のみを通し、チャット・ファイル・ログへ出していない。
- 未配信版 `7fb9c32e-81ce-4f64-b988-33bdee5c1f25` → 公開sitekey追加版 `3c6fec8d-474d-4690-b783-7cfe2373497c` の順で準備・検証・閉鎖配信。既存Secret12件、KV、D1、設定を維持した。
- Google同意画面のホームを `/start`、プライバシーを `/self/privacy`、利用規約を `/self/terms` の本番同一オリジンURLへ保存。保存通知を確認。アプリ名、サポートメール、承認済みドメイン、scope、クライアントsecretは変更していない。リンク保存はGoogleのブランド審査完了を意味しない。

## 本番で発見した不具合

画面のTurnstileチェック後も、通常のブラウザからのGoogle開始が `CHALLENGE_FAILED` になった。実workerdで `ctx.fetchImpl = globalThis.fetch` としてメソッド呼び出しすると `Illegal invocation`、`globalThis.fetch` を直接呼ぶと200になることを、外部通信なしの最小再現で確認した。

既存のruntimeテストはD1に実workerdを使っていたが、Workerの呼び出しはNodeと注入fetchであり、この差異を検出できなかった。新しい `test/self-runtime/native-fetch.test.mjs` は本番bundleそのものをworkerdで動かし、実session/CSRF→Google開始→native fetch→fixture限定のSiteverifyを通す。初回成功・再利用拒否・hostname不一致拒否を検証する。RED1件失敗を確認後、default fetchだけを `globalThis.fetch.bind(globalThis)` に修正してGREEN。

[CloudflareのIllegal invocationの説明](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors)とも整合する。検証を緩める変更、secretの再発行、互換日付の変更はしていない。

## 修正版の配信・検証

- commit `5aa9d93d41f7d15fc54f8d2b23a51d882499c907`。unit208、runtime57、CFT E2E20が成功、fail/skipなし、元終了コード0。読み取りレビューのP1/P2なし。
- mainへfast-forward統合後にbundleを再生成し、検証済みworktreeとのSHA一致を確認。SHA-256 `61e0625bd6008ef12c40c65e6aa48484f13046e32882d675ded4d39cc478ac2f`。
- version `529d0645-198f-4c76-93cf-7ea9fd89a037`、deployment `e039031a-31bb-464a-af46-e17929d3e5cb`、100%。全binding維持とアップロード済みmodule hashを照合してから配信した。旧versionは保持。
- 本番7画面が200。statusは受付/処理false、接続intentは503 `REGISTRATION_CLOSED` を確認。
- 修正版で通常のブラウザ操作からGoogleのアカウント選択画面へ到達した。実際の送信前にメモリだけで保持したトークンを、成功後に別CLIセッションから再送し403 `CHALLENGE_FAILED` を確認した。同一ブラウザからの再送検証とは扱わない。
- ブラウザが発行した未使用トークンを別CLIから最初に送る方式は403だった。クライアント文脈の違いは未特定。通常ブラウザ経路の成功と混同せず、IP・hostname・actionの検証を弱めない。Widget管理APIの権限追加はしていないため、管理画面の設定確認と既存backend実検証を用いた。

## 復旧操作の追加点検

Google開始に失敗した後に同じ一回限りトークンを再送すること、期限切れでもGoogleボタンが有効のままであることをCFTの2テストで再現した。widget IDを保持し、送信開始時にtokenを破棄、失敗時にreset、期限切れ/error時に無効化する最小修正を実施。読み取りレビューで指摘された「送信中callback→失敗→非同期reset」の競合も追加テストでRED再現し、reset直前の再クリアで修正した。追加3ケースを含むCFT E2E23、unit208、runtime57が成功（元終了コード0、fail/skipなし）。再レビューのP1/P2なし。配信・最終検証の結果は追記する。

## 本人に引き継いだ操作と残り

本番のGoogleアカウント選択画面を開いて保持し、店舗管理アカウントでのログインを本人に依頼。現段階は `openid` だけでGBP権限の新規付与は行っていない。実接続テストに使う管理権限のある店舗名も確認中。既存Yoshiki Appsのlegacy予約を無断解除・移行しない。

Google同意、承認された店舗の接続、LINE確認番号、停止/切断、初期受付枠、Google表示/審査状態、公開承認の確認が残る。実口コミへの投稿、LINE送信、AI生成、課金、記事公開はこの作業では行っていない。

外部委譲はMEOが安全リスト外かつ本番認証設定を含むため省略。内部の読み取りレビューを外部委譲の代替とは数えない。秘密を含まない実行結果はignoredの `output/self-service/final-launch/`、テストログは同名のworktree側ディレクトリに保存。
