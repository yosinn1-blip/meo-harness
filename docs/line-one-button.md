# LINE登録確認カードをワンボタンにする専用設定

## 承認された仕様

本人が始めたセルフ登録で、LINEカードから元の登録ブラウザへ戻り、既存PINによる確認を続けられるようにする。通知先LINEの確認と、店舗の本番有効化・規約同意は別の段階のまま。

- 新専用設定 `SELF_LINE_ONE_BUTTON_ENABLED` は**文字列 `true` のみ**を受理する。
- 実効 `lineButtonConfirm` がON、処理可能・必須設定あり・pilot設定なしの場合のみ有効。既存autoPIN/autoButtonの優先関係を変えない。
- 未設定・OFF・不正設定では、従来の2ボタンカード／PIN経路を維持する。
- `GET /api/self/status` の安全なboolean `lineOneButton` は専用設定が存在する場合だけ返す。未設定時は旧statusのshapeを維持する。

## 配信とリンク

新設定ON時の手動 `/api/self/line/button` と、既存autoButton設定もONの自動配信だけが新 `link` methodを使う。既存autoPINの配信はplaintextのまま。`/api/self/line/test` は手入力用のplaintext PINを維持する。

新カードはFlex footerにURI actionを**1個だけ**設ける。

- ラベル: `確認して登録画面へ進む`
- URI: 設定済み固定originの `/start?openExternalBrowser=1` と、fragment内の `line-confirm`（6桁PIN）・`store`（公開store ID）・`expires`（PIN期限）
- PINやowner/session秘密をHTTP queryに置かない。fragmentは通常のHTTP GETへ送信されない。
- 本文には5分以内、本人が始めた登録のみ、リンク転送禁止、必要時用の目視可能な6桁PINを含む。店舗名は既存同様300文字まで。

PINはLINEカードとブラウザfragment上の短命な確認資格情報。queryにないことは、LINEカード、クライアント履歴、クリップボード等にも存在しないことを意味しない。実PIN・カードURIをログや共有ノートへ転載しない。

## 認可と確認の境界

`line_checks` に既存方式のHMAC PINを保存し、既存 `verifyLinePin` と `/api/self/line/verify` をそのまま使う。カードにpostback actionはなく、リンクを開いても署名済みLINE receiptを捏造しない。

GET・status・URIの表示では確認を完了しない。元の生存中owner/session、正しいOriginとCSRFの明示的PIN確認POSTが必要。別ブラウザ、別owner、世代変更、5分経過、5回失敗、使用済みPINは既存方式で拒否する。

既存の署名postbackカードは、新flagをON/OFFするだけでは無効にしない。`receiveLineButton` / `confirmLineButton` は変更せず、旧カードの生存中のchallengeは従来通り確認できる。再送によって配送attemptが交代した旧postbackは既存bound条件で拒否する。

## 期限・配送・上限

- 新link claimで旧PINを取り除き、消費済み `line_links` の元ブラウザbindingを5分維持する。quota待ち後の新PIN保存時にも新PIN期限まで延長し、未使用の登録コードを延命しない。
- 新実効flagONの**手動plaintext PIN**でもbindingを新PIN期限まで維持する。新flag未設定/OFFのPINと既存autoPINの時間原則には変更を広げない。
- PIN再発行は既存の6桁乱数/HMAC経路を使う。古いPINレコードは新しいレコードへ置き換わる。clientはstore/expiryも照合し、古いリンクの自動prefillを拒否する。
- 1分1回、一般利用者の日次3回、既存の本人限定日次解除、月間予算、LINE事業者枠、配送claim・世代・session再確認、有限の自動配信deadlineを維持する。
- 自動リンク配信の重複実行は再送しない。不明な配信結果は `uncertain` と予約容量を保持し、有効なPINによる明示確認を可能にする。status GETは再送しない。
- 新設定がquota待ち中にOFFとなれば未送信予約を解放して停止する。既に届いたPINの手入力確認は新flagOFFでも従来経路で可能。

## データと戻し方

schema変更なし。新テーブル・新receipt・新APIは追加しない。専用設定を文字列 `false` に戻すと新しいカード配信を従来形式へ戻せる。既存PIN検証／旧postback確認は別途保持する。

`wrangler.toml`、本番設定、認証情報、公開・deploy操作はbackend実装担当では変更しない。外部GLM実装委譲は認可/署名関連かつ安全リスト外のため省略。依存追加・インストールなし、既存の検証用依存リンクを利用する。

## テストと残る確認

`test/self-runtime/line-one-button.test.mjs` はMiniflare native D1を使い、LINE通信を厳密なfixtureに限定する。実LINE、Google、本番DBへの通信はない。

確認対象: 厳密設定、単一URIとfragment、PIN非露出status、GET読み取り専用、本人POST、手動/自動互換、重複・不明結果、新旧カード、元ブラウザ/owner/CSRF/Origin/session/世代/期限/試行数、binding全5分、予算/日次制限、本人日次解除の継続。

UIのfragment取込・store/expiry照合・ボタンの明示操作、通常Chromeでの実利用フロー、全既存suite、本番反映、実LINE到達は主担当の独立検証対象。専用テスト合格だけで実LINE到達や本番有効化完了としない。
