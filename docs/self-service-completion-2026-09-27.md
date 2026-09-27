# 自己登録版の完成に向けた残課題修正

## 状態の区別

- Googleブランド表示は本人が公開後、Consoleで「ブランディングは検証済みで、ユーザーに表示されています」を確認済み。公開待ちではない。
- 本番Workerは従前の `1de869e1-d815-432f-b5e5-784f2c5c53c4`、一般受付/自己登録処理OFF、本人限定の接続確認版。今回のコード変更とは別。
- 2026-09-27にGroq `Personal` 組織の `Inference APIs ZDR` のみを本人の明示承認で有効化し、`Enabled`を実画面で確認。Global ZDR、Batch、Fine-tuning、課金、APIキーは変更なし。本番Workerの既存キーとこの組織の対応は別途照合が必要で、画面だけから確定しない。
- 本番settings APIでLogpush=false、tail consumers=[]を確認。observabilityは返却されず、全リクエストログの無効化を確認したとは扱わない。

## 修正内容

1. legacyの停止済み店がcron/バッファ/direct review/テスト通知から動く不具合を先に再現して修正。state未設定の旧形式とactiveの互換性を維持。開始済みHTTPの取消しやKVの即時整合性は保証しない。
2. cronを偶数UTC時の口コミ取得1店舗+AI1件、奇数時の通知1店舗+不明返信照合1件に分離。失敗pollも順送りし、枠切れjobを翌月へ回す。通知は独立のround-robin。最大5店舗時には1巡に最大10時間かかり得るため、即時通知を約束しない。
3. 放置登録の削除は1回1店舗。試験用D1計数はbatchを1 binding call、各SQLを別のstatement数として両方測る。AI保存3回失敗、LINE429/timeout/受理後DB失敗、5店舗公平性を試験。binding計数だけでCloudflare実環境の全制限を検証済みとはしない。
4. `0002_gbp_cache.sql`で実取得時刻を追加。既存NULLを現在時刻で埋めない。稼働中のaccount/locationを7日ごとに実API GETで再取得。21日未更新ならCAS付き切断。再開時も実再取得とmetadata更新をactivation transactionに含め、再開成功直後の清掃による誤切断を防ぐ。
5. 口コミ本文7日、元review ID21日、照合用の処理コード70日。取得対象をrolling60日以内として、照合コード削除後の古い口コミの再生成を防ぐ。未生成の枠待ちjobは新しいAPI取得で再水和できる。古い通知ボタンは本文期限/世代で拒否する。
6. AI利用量は月別HMACスコープへ移行し、同じGBP店舗の別owner再登録でも当月枠を復活させない。旧raw台帳の消費を移してから削除し、再実行で二重加算しない。AI台帳は月末/作成後ともに7日、LINE台帳は従前どおり90日を過ぎて削除。`SELF_RATE_KEY`変更時は当月枠を引き継ぐ移行を先に設計し、単純交換しない。

## 保存方針の根拠と限界

[GBP Content storage](https://developers.google.com/my-business/content/policies#content-storage)はAPI Contentの一時保存を30暦日以内とする。生データ21日という内部期限は、[D1 Freeの7日復元履歴](https://developers.cloudflare.com/d1/platform/limits/)を考慮した余裕のある基準。cron停止/滞留/別バックアップ/プラン変更まで無条件に30日以内と保証するものではない。未更新店舗・清掃滞留を監視し、一般受付枠の拡大前に最長待ち時間を再計算する。

HMAC利用量と照合用コードは自サービスの不正利用/重複処理防止のための最小運用記録であり、匿名情報ではない。GoogleがHMACや派生コードをContentの例外として明記したことは確認できていない。本書は法的適合の保証ではない。プライバシー案内で保存目的/期間を明示する。

## 本番切替と復元のチェックリスト

- 固定commitでunit/runtime/CFTを再実行し、原文ログ、終了コード、件数、bundle hashをmanifestに固定する。
- 本番self stores=0を再確認してから追加migrationを適用。既存binding、検証ファイル名、秘密、Free設定を保存し、不要な上書きをしない。
- 本人の `Yoshiki Apps` の旧運用を停止する場合、未配信pending/replyと処理中HTTPを再確認。state書き込みだけで即時停止とせず、KV伝播と送信停止を観測してからlocation予約を移す。美容院の接続は行わない。
- 所有店舗の選択までは既存owner-only pilotを使う。以後は一般受付OFFのままpilot bindingを外し、最大1店舗/AI1件/LINE push3通の試験枠で実確認。実LINE送信、旧接続削除、self切断は承認範囲を再確認する。Googleへの実返信投稿はしない。
- 旧方式のGBP KVフィールド、legacy予約、`gbp-last:*`、古いpending/reply、旧資格情報コピーは一般受付前に撤去を確認する。今回のself TTLでlegacy KVまで清掃できたとは扱わない。関係のない店舗設定/LINE中継を消さない。
- D1復元時は受付/処理をOFFにしてから実施。復元で切断済み資格情報や承認を復活させない。別の確実な削除台帳がない場合は、復元された全接続を切断して新規本人認可を要求する。生のDB/秘密/口コミをローカルやgitへ追加バックアップしない。
- 実確認でLINE受信、Google口コミ0件の正常表示、停止後の処理抑止、切断後の資格情報除去を分けて記録する。PIN/Google subject/LINE ID/秘密はログに記録しない。
- 一般受付・記事公開はこの試験と別のgate。承認前には開けない。失敗時は受付/処理をOFFのまま保持し、原因を確認する。

## 外部委譲

当該2パスはZ.ai安全リスト外のため外部実装委譲を行わない。既存worktreeでCodexが実装し、独立エージェントは読み取りレビューのみ。作業前のmain/worktreeはclean、変更は本作業によるものだけ。

## 証跡

ignored `output/self-service/completion/` にRED/GREENの生ログと元終了コードを保存。Googleブランド/本番反映の過去証跡と今回の未デプロイコードの証跡を混同しない。Groq設定変更の前後画像は本repo側の同名ディレクトリに保存。
