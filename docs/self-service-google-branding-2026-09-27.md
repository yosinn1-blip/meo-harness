# Googleブランド確認と所有権確認

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

この時点では検証済みコードの反映準備まで。実デプロイ、HTTP一致、Search Console確認、Googleブランド再確認の結果を追記する。一般公開gateはfalseのまま。

証跡はignored `output/self-service/branding/`、Google画面は `output/self-service/launch-audit/`。秘密・実確認値は本書や生ログに転記しない。
