# Googleブランド確認と所有権確認

**後続確認:** 本人がブランドを公開後、Google Consoleで「ブランディングは検証済みで、ユーザーに表示されています」を確認済み。本文末の公開待ちはその操作前の履歴です。一般受付の公開とは別です。

## 承認範囲

本人が、Googleアプリ名を `MEO Harness` に統一し、本人のGoogleアカウントで `https://meo-harness.yosinn1.workers.dev/` の所有権を確認することを承認。確認ファイルと保存期限修正3件の本番反映、ブランド再確認までが対象。一般受付・自己登録のAI生成/LINE送信はOFF、1店舗/下書き0/送信0の本人限定pilotを維持する。課金、ドメイン購入、他人への権限付与、既存店移行、記事公開は含めない。

## 本番反映前に確認したこと

- 未使用の `gmail.readonly` だけをGoogle Consoleから除外して保存。検証センターで「データアクセスの検証は不要」を確認。既存の認可tokenは失効させていない。
- Googleのアプリ名を `MEO Harness` に変更し、「ブランディングの変更を保存しました」を確認。ホームページ・プライバシー・規約・support連絡先・承認済みドメインは維持。
- ブランド側の既存指摘は、ホームページ所有権未確認とアプリ名不一致。Search ConsoleのURLプレフィックスで、指定オリジンのHTML確認ファイルを取得。DNS・ドメイン全体の設定は変更しない。
- 確認ファイルの内容はGoogleから取得した実ファイルと照合。実ファイル名/値はgitに含めず、本番 `SELF_GOOGLE_SITE_VERIFICATION_FILE` だけで設定する。この公開確認ファイルは所有権維持に必要なため、後続デプロイでもbindingとルートを保持する。

## 実装・検証

確認ファイルは `google` + 16桁の小文字16進数 + `.html` の形式で、設定値と完全一致するルートだけGETで返す。本文は固定形式の確認文字列。認証・DB・外部APIを使用せず、query/body/他の環境変数を返さない。未設定/不正設定/別パスは404、GET以外は405。既存ホームページや受付条件は変更しない。

TDDでGETの404とPOSTの404を先に再現（期待は200/405、元終了1）。対象10件成功後、全体を再実行しNode214件・実D1/workerd70件・CFTの架空provider E2E25件、計309件成功。fail/skip 0、元終了コード0。buildと `git diff --check` も成功。読み取り独立レビューでルート変更のP1/P2なし。実LINE送信・Google実投稿の成功を意味しない。

外部委譲ゲートは現行設定でMEO本repo/既存worktreeがZ.ai安全リスト外と再確認。認証境界の小変更をCodex内で実施し、外部へ内容を渡していない。

## 本番反映・再確認

2026-09-27 16:36 JST、承認範囲を本番へ反映した。

- 対象commit `55b26d066d87d4630df997856a3b118c5a3b6534`。このcommitを固定して全309件を再実行し、テスト前後のclean状態、各件数/exit/生ログhash、bundle hashをmanifestへ記録。staging/deployも同じcommit/hashを要求する。独立レビューで発見した古い成功ログの混同リスクは、この固定とmanifest照合で解消済み。
- 本番version `1de869e1-d815-432f-b5e5-784f2c5c53c4`、100%。deployment `b18bf9b6-28eb-4a59-9939-c32e7fdc1eca`。bundle SHA-256 `148d651d74723e5d8d86916ae7e872b911a5981d2da467910f9184406b497fba` がローカル・未配信版・配信版で一致。確認ルートに加え、既存commit `4a4ea72` の保存期限修正3件も反映。
- 既存binding/secretをすべて継承し、確認ファイル名のplain_text bindingだけ追加。compatibility設定、usage_model、placement、tail、Logpush、cron、workers.dev公開/previews設定の前後一致を確認。課金設定や認証秘密を変更していない。
- 確認用HTTPは200、Googleから取得したファイル内容と完全一致、redirectなし、Cookieなし。主要7ページも200。
- 公開statusは受付false・処理false、本人限定pilot、1店舗/下書き0/送信0/既存LINE確保180。匿名のGoogle接続開始は503 `REGISTRATION_CLOSED`。DB集計は店舗0/資格情報1/自己登録返信0/legacy予約1で前後一致。
- Search ConsoleがHTMLファイルによる「所有権を証明しました」を表示。URLプレフィックスの所有権確認成功であり、親ドメイン全体の所有権取得ではない。
- Googleブランドの再確認をリクエストし、画面で「ブランディングは検証済み」を確認。未使用Gmail権限除外後のデータアクセス検証も不要。**まだユーザー表示へは未公開**で、Google画面は検証結果の7日後の期限切れを案内している。

最後の「ブランディングを公開」は、検証済みのアプリ名/案内URLをGoogleログイン画面へ反映する別操作として本人へ確認中。一般受付の公開とは区別する。今回のWorker反映・所有権・ブランド検証成功だけで、実LINE確認、自己登録の停止/切断、保存運用、一般公開gateをtrueにはしない。実LINE送信・Google実投稿・既存店移行は行っていない。

証跡はignored `output/self-service/branding/`、Google画面は `output/self-service/launch-audit/`。秘密・実確認値は本書や生ログに転記しない。
