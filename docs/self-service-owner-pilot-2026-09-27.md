# 本人限定・1店舗の接続試験

## 承認範囲

2026-09-27、本人から「今のアカウントだけ・1店舗限定の試験登録。一般受付・AI生成・LINE送信・口コミ公開は停止したまま」の承認を取得。

既存の本番DBに認証済み利用者が1人、Googleログイン成功を前段で確認済み。GBP権限・店舗・LINE接続は未確認。ログイン成功とGBP接続成功は別。

## 設計・受入条件

- `SELF_PILOT_OWNER_SHA256` Secret に認証済みGoogle subjectのSHA-256を保存。実値・元識別子をソース、ログ、証跡に残さない。唯一の利用者・有効セッションを再確認してから作る。
- 既存のセッション、CSRF、Turnstile、PKCE、署名検証済みID tokenを使い、許可対象を照合。リクエスト本文の識別子は採用しない。
- Secretの存在時は一般受付と自己登録側処理を強制OFF。Secret不正・公開/処理フラグtrue・上限が1店舗/下書き0/送信0以外なら接続も拒否。
- 許可対象だけ接続/再接続・店舗一覧・選択を可能にする。OAuthの戻りでも許可を再確認。認可途中の失効、Googleアカウント切替、2店舗の同時選択、既存KV店の重複を拒否。
- 接続・店舗選択で画面を止め、LINEコード発行・本人確認・AI・通知・承認投稿・LINE結果返信も止める。既存KVの運用は変更しない。
- 本番一般公開・記事公開のgateをこの試験だけでtrueにしない。Google同意の最終許可と実対象店は本人確認が必要。
- デプロイは既存Secret/KV/D1/cronを維持し、未デプロイ版→照合→本番反映の順に実施。課金契約変更なし。

## 実装前の委譲判定

安全リストを確認し、本repo/worktreeはZ.ai許可対象外。認証・本人識別子に関わるため外部委譲を省略し、Codexで実装/検証。レビューは既存の読み取り専用レビュアーを使用。

## 検証記録

追加設定/D1テスト6件のREDを確認し、実装後6件成功。テストfixtureの誤ったDB列名は正規schemaに修正してからREDを再確認。全suite・本番結果は下記へ追記する。


独立レビューで、店舗選択bodyの`sub`による上書きと、店舗ありpilot再接続の途中失効判定漏れを検出。両方の失敗を隔離D1で再現後に修正。所有者をsession由来で固定し、開始時pilot intentをサーバー側に記録して戻りで再確認する。通常の既存利用者の再接続は維持。

最終ローカル検証：Node 210/210、実D1/workerd 64/64、Chrome for Testing E2E 25/25成功（fail/skip 0、各元終了コード0）。本番bundleビルドと`git diff --check`成功。LINE/開始ステップの`hidden`がCSSのflex指定で上書きされる問題もCFTでREDを確認し、明示CSSで修正後に全25件を再実行。

E2Eは架空プロバイダであり、実GoogleのGBP権限・実店舗・LINE到達の証拠とはしない。接続後画面のスクリーンショットを目視確認し、操作が接続確認までで停止することを検証。

本番の唯一の認証済み利用者を再確認し、元識別子とハッシュを出力せずSecretを未デプロイ版へ追加済み（`ee618b35-1e03-4c7b-a173-b2288b0db3d9`）。本番版はこの段階で変更なし。コード反映と実ブラウザの結果は次に追記。


## 本番反映・引き継ぎ

- 実装commit `48524e2` をmainへfast-forward統合し、bundle照合後にversion `aebed4ba-5a22-4508-9adc-af876e3fdf2f` を100%反映。deployment `dde1f1f6-c839-44c7-9064-3745f79a2cc0`。
- Bundle SHA-256 `4938839973f8a94a49cfd1af4bb9b6354d4d9e89cf928744a63396f0b1cfa397`。本番JSはローカル原本と一致。旧Secret全件・KV/D1を維持。変更は本人限定Secret追加と接続上限0→1のみ（受付/処理false、下書き/送信0）。
- デプロイ直後のHTTP検証は旧版の応答を観測して停止したが、CLIは終了0・APIは新版100%だった。再デプロイせず読み取り再確認で新版のpilot設定を確認した。外部伝播の一時差と整合するが厳密な原因は未特定。
- 7公開URL 200、匿名statusはpilot=true/一般受付false/登録許可false/処理false、匿名connectは503。DBは店舗0・GBP資格情報0・自己登録claim0・legacy claim1を維持（接続開始前）。
- 実ブラウザの既存ログインセッションで本人限定の接続ボタンが表示・有効化。新しいOAuth開始が成功しGoogleアカウント選択画面へ到達。本人が先ほどと同じアカウントを選択し、GBP権限を確認・許可する操作待ち。Google権限の最終許可・実店舗選択・LINE・口コミ投稿は未実施。
- 一般利用/記事公開gateはfalseのまま。既存のKV店の予約は解放しない。

秘密を含まない証跡はignoredの `output/self-service/final-launch/pilot-live-verified.json` と `pilot-google-account-handoff.png`。認可URL・Cookie・Google subject・allowlist hashは記録しない。


## Google接続成功後の確認

本人の操作後、実ブラウザは `/account` の店舗選択画面に戻り、GBP店舗一覧の取得成功を確認した。本番D1はGBP資格情報1件、自己登録店舗0件、自己登録claim0件、legacy claim1件。前段の「GBP資格情報0件」「権限許可待ち」は接続前の記録。

現在の候補は `Yoshiki Apps` 1件で、既存legacy予約済み。美容院は現在の一覧に表示されていない。既存店の選択・予約解除・別店舗の推測登録は行わず、試用する美容院の店名またはGoogleマップURLを本人へ確認した。管理権限不足・Googleアカウント違いなどの原因はまだ未確定。

実Google接続成功と、サービス全体の実運用開始は別。LINE本人確認・口コミ取得・停止/切断の実証が残るため、公開gateは引き続きfalse。今回は読み取り検証と記録のみで、デプロイ・認証変更・LINE送信・口コミ公開なし。証跡は `output/self-service/final-launch/pilot-google-connected.json` と `pilot-google-connected-store-list.png`。外部実装委譲の対象なし。
