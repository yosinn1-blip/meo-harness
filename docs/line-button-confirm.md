# LINEボタンによる通知先確認 — ローカル実装

2026-10-02。既存 `e3d04f3` からのローカル変更。本人の承認を受け、数字の記憶・コピー・入力を省く方式を実装した。本番への追加反映、フラグON、実LINE送信、新しい権限取得は実施していない。Libraryの片面チラシversion3と既存の説明資料は保持する。

## 本人の操作

Google本人同意と店舗選択 → 登録コードを入力済みのLINEを本人が送信 → 元のブラウザに戻る → 「確認メッセージをLINEに送る」 → LINEの「このLINEで確認」 → 「登録を続ける」から元の登録画面へ → 「通知先を確認して次へ」 → 条件を読んでチェックし利用開始。

確認メッセージは従来の手動PINメッセージ1通をFlexメッセージ1通へ置き換える。ボタンの受理・画面復帰・状態更新による追加送信や完了返信は行わない。自動PINはOFFのため、LINE訪問2回と元のブラウザへの復帰は残る。登録全体が1操作になるものではない。

戻り先は設定済み公開originの `/start?openExternalBrowser=1` だけ。所有者、店舗、PIN、確認nonceをURLへ入れない。[LINEの外部ブラウザ指定](https://developers.line.biz/en/docs/line-login/using-line-url-scheme/)を使うが、元と同じブラウザ・タブ・Cookieが選ばれる保証は確認できていない。これは実機未検証の設計上の留保。別ブラウザではログインを引き継がず、元のSafari/Chromeタブへ戻る案内だけを表示する。

## 確認の境界

- nonceは32bytesの乱数、有効5分、用途 `confirm_line_destination_v1`。DBには用途付きSHA-256だけを保存する。LINEのpostback本文にはnonceが必要だが、URL・ログ・公開statusへ追加しない。
- 所有者、登録を開始した生存session、店舗、現在generation、通知先LINE、現在の送信attemptをD1で照合する。署名は既存のraw-body HMAC経路で検証した後にdispatchし、個人トークの `source.userId` が通知先と一致する場合だけ受理する。[署名仕様](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)、[postback仕様](https://developers.line.biz/en/docs/messaging-api/actions/)
- LINE操作ではreceiptを記録するだけで、店舗は `line_pending` のまま。元所有者のOrigin/CSRF付き、`confirmed:true` の明示POSTで同じ束縛を再照合して `line_verified` へ移す。利用開始は従来の同意とactivation判定を別に通す。
- 最終確認はguardと状態更新を一つのD1 batchで実行する。事前読取後に世代が変わってもguardが拒否し、そのbatchをロールバックする。[D1 batchのトランザクション仕様](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- 重複postbackは有効な同一receiptに限り冪等、本人の二重確定は1回だけ成功。転送された別LINE、別所有者、同所有者の別session、偽署名、group/room、用途違い、期限切れ、失効session、旧世代・旧attemptを拒否する。
- 新しい確認/送信APIへのGETは認証・rate更新前に404。固定戻り画面と専用 `GET /api/self/line/return-status` は状態を変えず、匿名sessionも作らない。別sessionには `{ok:true,state:"line_return_mismatch",csrf:null}` だけを返す。既存通常の `/api/self/status` の匿名session生成は従来どおりであり、全GETが無書込という主張ではない。

## 送信・PINへの復帰

既存の1分1回・1日3回、共有送信枠、provider残量判定、90秒lease、attemptごとのretry keyを使う。ボタンとPINの枠を別に増やさない。送信前取消は未使用予約を解放し、結果不明は保守的な予約を保持して自動再送しない。実際に届いた結果不明カードの有効なreceiptは確認できる。

送信結果は現在attemptだけを更新し、遅い完了で新しいattemptやreceiptを消さない。dispatch前の判定を通過して外部APIへ渡った通信は取消せない。取消直後の遅延到着はあり得るが、世代・session・attemptを再照合して古い確認を拒否する。

本人が「番号で確認に切り替えて送る」を押すと従来PIN経路を使う。新しいattemptで古いボタン/receiptは無効になる。ボタンに切り替える場合はclaim batch内で旧PINを削除する。どちらも枠・送信失敗・結果不明の保留を尊重し、方法の切替だけで確認済みにしない。期限切れ、枠保留、既知送信失敗では元画面に送信/復帰を示し、使えないカードを開く案内は出さない。

## フラグと保持

`SELF_LINE_BUTTON_CONFIRM_ENABLED` は既定 `false`。明示 `true` かつ稼働構成、processing ON、pilotでなく、自動PINが明示ONでない場合だけ有効。両方ONなら従来自動PINを使い、ボタンAPI・postback確定は無効。ボタン方式は手動送信だけで、自動化を追加しない。

`0005_line_button_check.sql` は `line_button_checks` 一表の追加だけ。既存schema/行は変更しない。フラグOFFでは新表を参照しないので、0004までのschemaでも従来PINを使える。旧Workerも追加表を参照せず稼働できる。解除、session削除、登録コード再発行/削除は既存親への外部キーcascadeで確認記録を削除する。

期限切れカードが黙ってPIN画面になるのを防ぐため、method markerを親のconsumed link/sessionの削除まで残す。有効性は5分で失う。消費済みコードの保存期限だけを新カードの5分間までMAX延長する場合があり、未消費コードの期限や単回性を延長しない。既存の毎時cron・一回100件の親cleanupで削除する。通常は親linkの15分程度＋cron待ちだが、backlogがあるため厳密な削除時刻は保証しない。送信予約・監査の従来保持期間は変えない。

## 検証と実機の留保

native workerd/ローカルD1、実Workerの署名検証、架空Google/LINEの画面試験で検証する。LINE画面は受け取ったFlex payloadから作る架空fixtureで、実LINEの表示証明ではない。通常Chromeのheadless・一時profile・sandboxを使い、本人のブラウザに触れない。実LINE Flex API受付/到達、iOS/Androidの外部ブラウザ復帰、元Cookie、実Google同意、実利用時間は未確認。検証ログと画像は `output/meo-line-button-integration-20261002/` に保存する。

初回の新規画面試験は5件成功/3件失敗。既存同意UIの期待と非同期完了待ちを修正し、再実行8件成功。独立レビューの重要所見2件（期限切れmethod保持、未送信時LINE案内）を修正して否定試験を追加した。最終の全体件数、レビュー所見、ソースhashは同出力先のresult/README/review記録を正とする。

## 将来の本番反映案（未実行）

1. このローカル差分・最終レビュー結果と現在の本番状態を再照合し、schema追加/Worker反映/限定実機試用の具体的対象を本人へ提示して承認を得る。過去の店舗0や解除済み記録を現在の本人登録状態として扱わない。現状の実店舗を削除・再登録して準備しない。
2. 本番は過去に0001〜0004を直接SQLで適用したためmigration履歴表と実schemaが一致するとは限らない。実schemaの存在確認後、必要な0005一つだけを適用する案を使う。`migrations apply` で過去全件を再実行しない。既存行とschemaの読取比較を行う。
3. 現在の全bindings、14secretの名前/type（値は読取しない）、vars、上限、Cron、compatibility、Worker URLを保持した具体的dry-runを作る。最初のコード反映は `SELF_LINE_BUTTON_CONFIRM_ENABLED=false` と `SELF_LINE_AUTO_PIN_ENABLED=false` を保持し、既存PINを確認する。
4. その後、明示的に許可された本人店舗・LINE・時間枠でbutton flagだけONにして実機確認する。フラグは店舗別でないので受付範囲を既存設定で限定する必要があり、その変更も事前の具体的承認に含める。受付OFFだけでは既存の他所有者の未完了登録を除外できない。ON直前に読取で影響する未完了登録が本人だけか確認し、他所有者がいれば本人限定と称してglobal ONせず、追加scope設計か実際の影響範囲を明示した承認が必要。既存pilotモードはbuttonを無効化するので限定ONの代替に使わない。実機結果で採否を判断し、勝手に一般有効化しない。
5. 現在のLibraryv3は公開中の手動PIN方式に対応する。ボタンを本番採用する場合のチラシ/公開案内更新は別変更とし、元版と履歴を保持して本人へ確認する。

戻す場合は新Workerのbutton flagをfalse、自動PINもfalseにし、同じ既存枠の中で本人が明示的にPINを送り直す。この方法では専用戻りGETの読取性を維持する。既にdispatchした送信や結果不明の予約を取り消し/強制解放しない。

コードの復帰が必要なら別途許可を得て直前の承認済みWorkerへ戻す。旧e3は戻りqueryを識別しないため、既発行カードの戻りリンクを別ブラウザで開くと通常statusの匿名session生成に戻る場合がある。LINE確定/利用開始は起きないが、フラグだけOFFにする復帰と区別して案内する。0005表は残し、データreset・破壊的migration・監査/予算削除で戻さない。
