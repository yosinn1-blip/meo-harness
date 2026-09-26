# AIに導入を手伝ってもらう場合

既定は運営者の共有サービスの `/start` から行う通常登録です。開発環境、自分のAPIキー、管理者キーは不要です。AIは画面の説明と操作の補助を行い、Google/LINEの本人ログイン・権限確認・店舗選択・公開投稿の承認は利用者自身が行います。

## 安全な手順

- 店名と利用者のGoogle管理権限を本人に確認する。Googleが認めた管理者を「オーナー本人」と断定しない。
- 人向けの [使い方](/self/help/quickstart) と同じ画面、同じ手順を使う。
- パスワード、Cookie、管理キー、refresh token、LINEトークン、登録コード、確認番号をチャットやログへ貼らせない。
- `/api/self/status` はログイン中ブラウザで利用する。CSRFやセッションを外部へ転送しない。一般APIが管理者キーやLINEチャネルトークンを要求することはない。
- 受付停止や利用枠不足を認証迂回、別人へのなりすまし、課金で解決しない。
- LINEのAPI受付を到達・Google投稿の成功と混同しない。Google投稿は個々の本文・対象を本人が確認した後だけ。

## 状態と次の操作

| 状態 | 次の操作 |
|---|---|
| anonymous | Googleで接続、または既存利用者のログイン |
| google_connected | 店舗一覧から確認して選択 |
| location_selected / line_pending | 登録コード→LINEへ送信→ブラウザで確認番号を照合 |
| line_verified / ready | 利用条件と上限を本人が確認して利用開始 |
| active | LINEの返信案を本人が確認・承認 |
| needs_google_reconnect | 同じGoogleアカウントで再接続 |
| paused | 本人が再開するか、切断を選ぶ |
| CAPACITY_UNAVAILABLE / REGISTRATION_CLOSED | 新規受付停止を案内し待機。迂回しない |
| PIN_INVALID / LINE_BROWSER_MISMATCH | 元のブラウザを確認し、必要なら登録コードからやり直す |
| GOOGLE_PERMISSION_DENIED | 権限の用途を説明し、本人に再試行の判断を任せる |

Google接続からLINE確認までのローカルE2Eは架空プロバイダを使います。架空デモの成功を本番利用可能と説明しないでください。

自分のインフラに設置する希望が明確な場合だけ [自前運用](/self/help/self-hosting) を案内します。通常登録と、自前のGoogle Business Profile API承認が必要な設置は別です。未知の外部リポジトリにFull Accessを勧めません。
