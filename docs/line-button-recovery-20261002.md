# 自動確認カード後の停止と回復画面

2026-10-02のローカル修正候補。本番への反映、追加LINE送信、利用履歴のリセットは行わない。

## 確認した事実と未確認

本番391d953/566b2e04（autoButton ON、button ON、autoPIN OFF）。16:36:48にgen4コード受理、16:36:49に送信受付。16:40:40時点で現在カードは有効、保存済みowner/元session/世代/宛先/purpose/attemptは一致、確認receiptは0。16:41:48にカード期限切れ。16:47:27もreceipt/元画面確定0、当日確認送信3/3使用済み。時刻限定SELECT計5件、書込み0、識別子・秘密値・本文を返さない。

16:37の初期停止は期限前。期限切れと日次枠到達は後続の回復を妨げる。LINE確認postbackはブラウザcookieを読まないため、別ブラウザへの復帰だけではreceipt 0を説明できない。実端末のbrowser/tab復帰は未観測。

「2 登録画面へ戻る」はURIだけでreceiptを作らない。古い差替カードの「1」は署名済Webhookでも拒否され、現在カードは未確認のままになる。この2経路はローカルで再現でき、今回の表示と整合する。ただし実際にどのカードを押したか、postback未到達/拒否のどちらかは確定できない。

Webhookは署名検証後、HTTP200を返してwaitUntilで処理する。meo-confirm分岐は受理/拒否をDB監査に残さず、拒否はconsoleだけ。16:36:48〜16:41:49の監査集計0は、拒否がなかった証拠ではない。実送信本文は保持されておらず、action順/種別の証拠は配信版の固定ソースからの投影。架空nonceを使い、実nonceや本文を取得しない。

## 修正範囲

- 未受理を明示し、トークを開くリンクにカードの「1」を押す目的を表示する。
- 新カードの1番をprimary、2番をsecondaryにする。1番のdisplayTextは押した事実だけを示し、サーバー受理/通知先確定を保証しない。追加push/replyはしない。
- 読取りstatusに送信制限の種別・再確認時刻だけを投影する。期限切れ・link保持整理後も日次枠を表示し、再送/PIN切替/コード再発行を無効化する。
- 有効なreceipt/PINの本人確定は送信制限で妨げない。期限切れPINは確認入力を出さず、開いた画面でも期限を読取り更新する。
- 日次bucketはJST日付で切替。待ち時間は既存row期限と次のJST午前0時の早い方とし、minute制限は独立して残る。rate/予算をリセットしない。

署名、nonce、用途、元session、owner、世代、LINE宛先、attempt、5分、CSRF、単回の確認、利用条件の明示同意は維持する。配送・枠消費・DB書込み分岐・schema・新OAuth・設定フラグは変更しない。共有/provider送信枠は別に既存検査を続ける。

## 次の本番変更・実試験

具体的な差分と検証を本人へ提示してから本番反映の承認を得る。反映は現在のautoButton/button ON・autoPIN OFFと全既存設定を保持し、履歴のリセットや上限回避をしない。

実試験を追加承認する場合は、使える送信枠で新しいカード1通だけを受け、1番の押した表示と元画面のreceipt表示を区別して確認する。今回は本人へ追加操作を要求しない。実LINEの到着/描画と今回のイベント欠落原因は未確認のまま。

出典: `output/meo-line-auto-button-loop-readonly-20261002`、`output/meo-line-button-recovery-20261002`。
LINE公式: https://developers.line.biz/en/reference/messaging-api/#postback-action 、https://developers.line.biz/en/docs/line-login/using-line-url-scheme/ 。
