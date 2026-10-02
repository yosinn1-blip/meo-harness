# LINE登録確認の日次上限を本人だけ解除する設定

## 対象と境界

- 対象はセルフ登録のLINE確認送信（手動ボタン、PIN、自動ボタン、自動PIN）の**日次3回上限だけ**。
- 認証済み店舗モデル `store.ownerSub` のSHA-256が専用設定と一致する本人のみ、日次 `consumeRate` をスキップする。HTTP body/query/headerの本人指定は使わない。
- 一般の利用者・未設定・OFF・不正設定・別ownerは従来の3回を維持する。
- 1分1回、LINE事業者枠、月間push予算、予約・配送claim、署名、セッション、CSRF、元ブラウザ、世代、PIN/nonce期限、明示的な本人確認は従来通り。
- 登録確認送信を増やしても、店舗の本番有効化やGoogle投稿は自動承認しない。確認完了と規約同意は別段階。

## 専用設定

| 設定 | 受理条件 |
| --- | --- |
| `SELF_LINE_CHECK_DAILY_BYPASS_ENABLED` | 文字列 `true` だけ。boolean、`TRUE`、空、未設定はOFF |
| `SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256` | 正しい本人のGoogle owner subをSHA-256した小文字64桁hexの文字列 |

生のowner subや実際のhashをコード、UI、公開ログ、コミットに書かない。hashは専用のprivate bindingとして取り扱い、本人照合には既存のconstant-time `safeEqual` を使う。

**`SELF_PILOT_OWNER_SHA256` は流用禁止。** この既存設定は存在するだけで一般受付とself処理を停止するため、別目的の動作になる。pilot設定が存在する場合は日次解除も認めない。

## UI/status契約

- 認証済みLINE pendingの正しいブラウザでは `lineCheck.dailySendLimit` に安全な値だけを返す。
- 明示的に許可された本人のみ `null`（日次上限なし）。他owner/OFF/不正設定は `3`。
- 専用設定が両方とも未設定なら従来互換のためフィールドなし。UIは未定義を3として扱う。
- 生のflag、owner sub、hash、LINE送信先は返さない。匿名/別ブラウザのreturn-statusは従来の汎用mismatchを維持する。
- 本人のstatusでは既存 `test-day` の3/3による待機だけを無視する。`test-minute` の待機は残す。status取得はDB・配送を変更しない。

## 既存データと戻し方

schema変更なし。既存の `rate_limits` の日次行を削除、リセット、更新しない。解除中の本人送信は日次行を消費しない。

専用flagを文字列 `false` に戻すだけで通常の3回へ戻る。既存の日次3/3行が生きていれば、OFF直後から再び送信不可となる。1分行・予算台帳・予約記録も保持する。設定変更・本番反映は別途承認されたリリース手順で行う。

## 検証

`test/self-runtime/line-daily-owner-bypass.test.mjs` はMiniflare native D1と厳密なLINE外部通信fixtureを使い、実LINEやGoogleへ通信しない。

確認対象: 本人の既存3/3後の4・5回目、ボタン/PIN共通のminute制限、未設定/OFF/不正/別owner拒否、request偽装、読み取り専用status、OFF復帰、月予算/事業者枠、手動/自動確認、セッション/CSRF/元ブラウザ維持、private設定非露出。

このテストの合格は本番設定反映・実LINE到達・Google実投稿を証明しない。リリース担当が差分レビュー・既存unit/runtime/e2e・安全な本番statusを別途検証する。

外部実装委譲は今回、安全リスト外の隔離cloneで認可に関わる設定変更のため省略。依存追加/再インストールなし。既存の検証用依存リンクを再利用する。
