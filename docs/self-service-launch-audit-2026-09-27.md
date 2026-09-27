# 一般公開の残作業監査と保存期限の修正

## 範囲と現在の判定

本人の「残ってるやつやってください」を受け、公開前の実確認と、合意済みの保存期限・停止設計に沿うローカル不具合修正を実施。clomusは未承諾のデモ候補のまま。本番登録・送信・移行・一般公開の許可へ拡張しない。

一般公開gateは引き続きfalse。ローカル修正と、その本番反映は別。架空環境の合格を実LINE到達や実Google投稿と扱わない。

## 2026-09-27 15:53 JSTの本番読み取り

- Worker versionは`aebed4ba-5a22-4508-9adc-af876e3fdf2f`、前後一致。受付false・処理false・上限1店舗/下書き0/送信0・既存LINE確保180を維持。
- 自己登録DBは店舗0、Google資格情報1、自己登録返信0、legacy予約1。DBサイズ241,664 bytes。
- 本人のYoshiki Appsは、ダイジェスト待ち0。KVの`reply:`をページング付きで全件一覧確認し、承認待ち0。実行中HTTPが存在しないことまで保証する観測ではない。
- 同店のGoogle口コミ取得に成功し、件数0。旧運用の認証によるGETであり、新しい自己登録経路の口コミ取得成功とは区別する。本文・投稿者・tokenは記録していない。
- LINEボット`MEO Harness 通知`の公式GETは4件とも200。共有中継が有効。月間200通、使用量API概数7。差193から既存分180を確保すると自己登録向けの余地は13通だが、反映遅延・他用途・未反映予約を含む確定残量ではない。
- 現本番にGmail関連binding/refresh tokenなし。Google Consoleには旧`gmail.readonly`が制限付き・未検証として残る。`business.manage`は非機密欄。新コードはopenidとbusiness.manageのみ要求する。
- Googleのブランド情報は登録済みURLを保持しているが、検証/公開済みではない。未使用Gmail scopeだけの整理とブランド確認について、対象と影響を示して本人へ確認中。設定はまだ保存していない。

## 保存期限の不具合と修正

1. 未稼働の接続が`needs_google_reconnect`や`paused`へ移ると、状態名による削除条件から漏れ、24時間経過後も資格情報が残った。
2. 反対に、稼働済みの店舗がLINE再接続で`line_pending`になると、未完了登録と誤認して店舗・Google資格情報を削除した。
3. 期限候補のSELECT後に利用開始・再接続操作が成功しても、無条件の切断が後から削除した。

未稼働は`terms_version IS NULL`で判定する。候補抽出後も、対象店舗ID・owner・期限・未稼働条件を削除と同じD1 transactionの先頭で再検査。不成立なら全削除をrollbackし、通常の明示切断は維持する。その他のDBエラーを握り潰さない。

実D1/workerdで5つの失敗（削除漏れ2、誤削除1、競合2）を先に再現。稼働済みGoogle再接続が残るケースを加えた6件の回帰を追加し、対象15件成功。独立した読み取りレビューでも当該3件に残存P1/P2なし。

全体再検証：Node 210件、実D1/workerd 70件、Chrome for Testing E2E 25件、計305件成功。fail/skip 0、各元終了コード0。ビルド・差分空白検査も終了0。E2Eは架空プロバイダで、模擬投稿の画面も目視確認済み。本番用bundle SHA-256は`9a98346f92a47f0f2a9f522d0add11b279e67ee6e0399eb374ece83fd3294970`。現在本番のbundleとは異なる。今回の修正は本番未反映。

外部委譲の実装前判定：MEO本repo/既存worktreeはZ.ai安全リスト外と現在設定で再確認。認証・削除境界の小修正のため、外部へ内容を渡さずCodex内で実装。既存の読み取りレビュアーを使用。

## 次の本番実証の前提

- Yoshiki Appsのlegacy予約を無断解除しない。現在の旧cronは`store.state`による停止を判定していないため、KVに`paused`を書くだけでは移行用停止にならない。既存経路の停止と復旧を保証する仕組み・テストを先に整える。
- LINE試験は本人が選んだ通知先だけ、送信回数と本文を先に承認。現在のpilotは接続確認専用でLINEを禁止しているため、そのままでは試せない。
- 口コミ0件は正常系として扱う。試験のための架空Google口コミを作らない。実投稿は別の対象/本文承認なしに実行しない。
- 一般公開の前に[Googleブランド確認](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)の結果・実OAuth表示、プロバイダ実利用枠、公開条件版を確認する。審査申請と審査完了を分ける。

## 保存・復旧運用の残り

- [GBP公式ポリシーのContent storage](https://developers.google.com/my-business/content/policies)は保存を最大30暦日の一時保存に制限する。店舗名キャッシュ、口コミID、利用量用location IDの項目別の保持方法・適用根拠は未解決。本文7日だけを見て条件適合済みとしない。
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)はFreeで7日。過去DBの復元により切断済み接続まで戻る可能性があるため、本番へ直接復元して処理を再開しない。復旧は別承認で、先に受付/処理OFF、削除状態の再適用と資格情報の点検、上限の復元を行い、実確認後に再開する。独立した削除記録がない場合は過去の接続を復活させず、再接続が必要な安全側復旧を選ぶ。
- 本番Logpushはfalse。Workersのobservability設定は今回のAPI応答に明示値なしで、trace/自動Invocationログ無効化まで確認済みとはしない。
- Groq Consoleと本番キー所属の一致、データ制御設定、正式な連絡先/条件版の確認を残す。OAuth tokenの無条件revokeは同じプロジェクトの既存認可に影響するため自動実行しない。

## Free実行上限の追加確認

1店舗・口コミ1件・下書き1件・LINE1通・期限切れ店舗0・結果不明返信0を、実装/既存schemaとメモリ内SQLiteで計数した参考値は、D1 binding呼出38回、SQL文70本、架空provider呼出6回。実Cloudflareでの上限検証ではない。最大5店舗・5下書き、cleanupで店舗を削除する場合、既存KV処理分はこの値に含まれない。

[D1制限表](https://developers.cloudflare.com/d1/platform/limits/)のFree 50 queriesと、[Workers内部サービスの制限](https://developers.cloudflare.com/workers/platform/limits/#subrequests)の数え方を区別する。[batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)は複数SQLを1callにまとめるため、70 SQL文だけを根拠に上限超過と断定しない。公開前に本番相当の1 invocation全体を計測し、上限内の処理件数を決める。課金変更で解消済みと扱わない。

## 証跡

本番読み取りはmainのignored `output/self-service/launch-audit/read-only.json`。ローカルのRED/GREEN、全体テスト、生ログと元終了コードは既存worktreeの同名ディレクトリ。秘密・Google subject・実口コミ本文は保存しない。公開・実送信・課金・資格情報変更は未実施。
