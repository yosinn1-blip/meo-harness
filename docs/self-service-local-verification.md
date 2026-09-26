# 自己登録：ローカル実装・検証結果

2026-09-27。コード検証対象commit: `5873ff3`（`feat/self-service-onboarding`）。

**結論:** 店主向け自己登録フローはローカル実装・検証済み。本番公開・実接続の確認とは分けて扱います。

## 実装した導線

Google本人ログイン/GBP接続 → 所有する店舗の選択 → LINE登録コード → 本人確認番号 → 利用条件と上限確認 → 開始。途中復帰、既存利用者ログイン、停止・再開・切断、AI向け案内を含みます。

口コミ取得・下書き・LINEダイジェスト・本人承認・Google投稿結果の照合をつなぎ、LINEとアカウント画面で結果を区別します。Google/LINE/AIを架空化したE2Eで、管理者APIなしの操作を確認しました。

## 検証結果

| 検証 | 結果 |
|---|---|
| `npm ci` | 終了0、audit脆弱性0 |
| `npm test` | 179件成功、fail0/skip0、終了0 |
| `npm run test:self-runtime` | 隔離D1で46件成功、fail0/skip0、終了0 |
| `npm run build:self-test` | 終了0 |
| `npm run test:e2e` | Chrome for Testingで10シナリオ成功、終了0、予想外の外部通信0 |
| production bundleを実workerdで起動 | start/JS/help/statusの4routeが200・no-store、外部通信0 |
| 隔離HOME・架空bindingのWrangler dry-run | 終了0、実デプロイなし |
| 本番bundleのテストfixture・鍵・迂回検査 | 対象の混入0 |
| `git diff --check` | 終了0 |

375px/1280pxの表示を目視確認。画像はテスト実行時に`output/self-service/`へ生成する架空データの画面で、本番実績ではありません。

## 独立レビュー後の修正

fresh-context reviewerの重要所見7件を、再現する失敗テスト→修正→全テストの順で処理しました。再レビューは行わず、修正後の差分と検証は実装担当Codexが確認しています。

1. 古いGoogle照合結果による新しい投稿leaseの上書きを防止。
2. provider残量・未反映予約・ローカル上限をD1で原子的に予約。
3. 7日保持期限後も未生成の口コミを再取得・復元可能に。
4. LINE 429等の未受付から、同じ本文とretry keyで回復可能に。
5. AI成功後のDB保存失敗では同じ本文を保存再試行し、重複生成を保留。
6. 承認結果・競合・再承認要求をLINE reply APIとアカウント画面で表示。
7. 古い世代・期限切れの投稿照合が後続の仕事を塞がないよう整理。

## 本番について未確認・未実施のこと

新機能のGoogle OAuth検証状態、実quota・利用枠、承認店舗での実接続、実際の停止/切断、正式な利用条件・連絡先・バックアップ保持期間、公開承認です。公開gateはこれら6条件で**blocked（終了1）**が正しい結果です。

今回、実店舗への投稿・実LINE送信・本番Secret/DB/OAuth設定変更・公開は行っていません。一般利用可能との記事掲載は[公開前チェック](self-service-release.md)を通過した後に行います。外部APIの原子性やquotaの概数反映には、同文書に記載した限界があります。
