# 自己登録版の閉鎖状態での本番反映

## 承認範囲と現在の制約

ユーザーの「残ってるのをやりきってください」を、直前に示したTurnstile管理画面方式・本番反映・登録から停止までの確認を進める承認として扱う。課金、実口コミ投稿、他店舗の無断接続、認証情報の無断回転は含めない。記事公開は引き続き実利用可能になった後という条件付き。

Cloudflare管理画面を開くとログイン画面だった。本人によるログインを依頼し、パスワードや認証コードをチャットへ送らないよう案内した。ログイン前のTurnstile作成や、CLIの権限を勝手に追加する作業は行わない。

## 判断

- 先に一般受付・処理OFF、店舗/下書き/push上限0の設定で、本番の画面・DB接続を準備する。これを一般利用開始や実接続成功とは扱わない。
- KVはそのまま保持する。専用D1へ既存GBP locationの予約だけ追加し、自動移行しない。
- 鍵入り未配信版を継承元として照合し、鍵値を読み出さず全既存bindingを保持する。新コードのhashと継承されたbindingを確認してから配信する（実際の継承形式は下記参照）。
- 既存cronとログ設定を維持する。OAuthのqueryやCookieを記録し得るリクエストログ/traceを今回新たに有効化しない。
- 外部実装委譲はMEOが安全リスト外で、認証・本番設定を含むため省略。独立した内部レビューを実施するが、外部委譲の代替とは数えない。

## 配信前レビューで検出した回帰

SELF_DBを追加すると、旧形式の`legacy:<storeId>`予約が同じ店舗IDの別location選択を拒否する。実D1テストで`LOCATION_UNAVAILABLE`を再現した。また同一店舗への並行再試行でも片方が失敗した。

修正はlocation単位の予約追加と所有者照合。旧locationを先に解放しないため、KVとの非原子的な保存や失敗時にも自己登録側へ重複して渡らない。旧予約を温存し、現在のスキーマは変更しない。

RED: 対象5テスト中2失敗。GREEN: 実Workerの管理ルート→架空Google→実隔離KV/D1の保存、KV保存失敗と再試行を含む6テストが成功。外部通信はfixtureへ限定。実Googleで店舗の選択変更はしていない。

修正後のworktreeでunit208、実隔離D1のruntime56、CFT E2E20が成功（fail/skip 0、元終了コード0）。bundle生成・差分チェックも成功。再レビューで未解決P1/P2なし。配信版、公開HTTP確認は実行後に追記する。Turnstileと本人による実接続は、この閉鎖反映で完了したことにはしない。

## 本番への反映結果（2026-09-27 13:23 JST）

- 対象commit: `dc33a91cb29b1a24d6e6425fa3637163a3d5ef91`。mainへfast-forward統合後にもunit208/runtime56/E2E20、署名付きLINE中継→実Worker→隔離D1の統合を再実行し成功。統合の外部通信0、旧KV書込0。
- Worker: `meo-harness`。新version `6d8a12ca-5836-4f5f-8508-97ddbf63506b`、deployment `80ad2ced-5127-4c78-8c36-4d30747f4d35`、100%。旧version `5be5104e-1db4-410c-82ed-738947fa1fe1` は保持。
- 本番bundle SHA-256: `b90d8dd8ab7f3bcd7d0a6b7b658a91cf9026a53d7da701dcae0a7ed482f59b09`。アップロード済みモジュールと検証済みローカルbundleが一致。
- 既存Secret12件を保持（自己登録用の2鍵を含む）。鍵値の読み出し・再生成・回転なし。既存KVも保持。
- 作成済み専用D1をbindingし、既存Yoshiki Appsのlocation予約だけ1件追加。既存店舗の自動移行なし。一般受付OFF・処理OFF・新規枠0を維持。
- 本番HTTP: `/health`、`/start`、`/account`、`/self/privacy`、`/self/terms`、FAQ、報告画面が200。`/api/self/status`も200で受付/処理false。正規の匿名セッション/CSRFを使っても新規Google接続は503 `REGISTRATION_CLOSED`。
- Chromeの専用タスクタブで受付停止表示→FAQ→報告画面の実導線を確認。登録用Googleボタンは無効。商品E2E20件はCFT専用のローカル環境であり、実Google/LINEの接続成功とは区別する。
- スクリーンショット: `output/self-service/final-launch/live-start-closed.png`。実メッセージ・口コミ投稿・問い合わせ送信・追加課金なし。

### アップロード形式の検証で止まった点と修正

最初のAPIアップロードでは、`type: inherit`に継承元の`version_id`を指定した13件がHTTP400/code10057で拒否された。詳細な原因は未確定。直後に現行配信・最新versionが不変であることをGETで確認。D1の既存location予約1件だけ追加済みだった。権限拒否ではないため認証の変更・別権限への切り替えはしていない。

インストール済みWrangler 4.81.1の`versions upload`実装を確認し、その正式な形式である`keep_bindings: [secret_text, secret_key]`へ修正。アップロード直前にも最新が鍵入り版`375501c3-1e54-4789-87ae-4f4551c65121`であることを照合し、1回だけ実行して成功した。旧非Secret bindingはそのまま保持、Secret名・新D1・公開設定・bundle hashを全照合してから配信した。元の失敗markerと次の実行markerは保存し、盲目的な再実行を禁止している。

[Cloudflare公式APIのinherit仕様](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)と[Secretsのバージョン管理](https://developers.cloudflare.com/workers/configuration/secrets/)を参照。現状では動作確認済みのWrangler形式を使い、版指定inheritがこの環境で動作すると推測しない。

## 残っている実利用開始条件

Cloudflareは引き続き本人ログイン待ち。Turnstile widget/secret/sitekey、実トークン成功・再利用拒否は未確認。Google同意画面のホーム/プライバシーURLは旧サイト、規約URLは空で、今回は読取のみ。共有版の公開案内との整合が必要。

LINEは今回もGETで月間200・使用概数7、MEO Harness通知ボットと既存中継URLを確認。概数や別用途の利用は正確な残量保証ではなく、新規受付枠はまだ0。Google/Groq実接続、承認された対象店の登録・LINE本人確認・停止/切断を終えるまでは、一般受付と記事公開を開始しない。
