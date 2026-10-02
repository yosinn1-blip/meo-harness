# 登録コード後の自動LINE確認カード

2026-10-02のローカル候補。本番へのデプロイ・有効化・実LINE送信は行っていない。

登録コードを本人のLINEから送ると、同じトークへ確認用Flexを自動で1通送る。
「1 このLINEで確認」は署名Webhookで確認操作を記録する。「2 登録画面へ戻る」は固定の外部ブラウザURIで、確認操作を記録しない。同じSafari・Chrome、元のタブやcookieが選ばれる保証はなく、別ブラウザでは元の登録タブへ戻る案内を表示する。
元の生存セッションで状態を読み取り、本人が「通知先を確認して次へ」を押して確定する。利用条件を確認して利用を開始する操作は引き続き別に必要。

現行の手動カードではLINEへコード送信→ブラウザへ戻って確認メッセージ送信→LINEへ再訪→確認→ブラウザへ戻る。候補ではコード送信とカード確認を1回のLINE訪問で済ませ、確認メッセージを送るブラウザのボタン1回とアプリ切替2回を省く。実スマホのアプリ切替・戻り先・カード到着は未確認。

## フラグと互換性

新しい `SELF_LINE_AUTO_BUTTON_ENABLED` は既定 `false`。本番を変更する場合の推奨組合せは、autoButton=true、button=true、autoPIN=false。

|raw autoPIN|button|autoButton|有効な方式|
|---|---|---|---|
|false|false|false|手動PIN|
|false|false|true|手動PIN|
|false|true|false|手動カード・明示的PIN切替|
|false|true|true|自動カード・明示的PIN切替|
|true|false|false|既存自動PIN|
|true|false|true|既存自動PIN|
|true|true|false|既存自動PIN、カード無効|
|true|true|true|自動カード・明示的PIN切替|

新autoButtonとbuttonを明示的にONにした場合だけ自動カードを優先する。新フラグOFFなら従来のautoPIN優先を保持する。文字列 `true` 以外、pilot、処理OFF、不完全な設定では自動カードを有効にしない。
推奨組合せから新autoButtonだけOFFに戻すと手動カードに戻る。raw autoPIN=trueも残っている場合は、新フラグOFFで従来の自動PINへ戻りカードが無効になるため、復帰後の方式を確認する。

## 期限と回復

未使用登録コード15分、確認カード5分、配送lease90秒を維持する。カード確認・元ブラウザ確定の双方が期限内に必要。
コード受理から配送記録が作られるまで20秒を読み取り専用で待つ。起点はD1のconsumed_atで、再読み込みで延長しない。配送記録ができなければ明示的な再送を案内する。
期限切れ、配送保留、拒否、結果不明は自動再試行しない。元画面での再送・PIN切替は新しい試行を作り、前のカードと確認操作を無効にする。送信1分1回・1日3回と共有利用枠・provider枠、retry key、結果不明の予約保持を維持する。

## 認可と検証境界

署名検証したコードイベントだけが自動配送を開始する。コード消費のD1 batchでも元セッション生存・owner・世代・リンクを再照合し、失効競合では全体を取り消す。自動Flexのフラグをclaim前、枠確保前、送信直前にも照合し、途中でPINに自動変更しない。
既存のnonce用途・owner・元session・世代・LINE送信者・attempt・一度限り・期限・CSRFの制約を維持する。戻りURI/GET/画面のpollだけではreceipt・確定・利用開始・再送をしない。別sessionに認証情報や店舗情報を渡さない。
新しいOAuth、migration、追加依存は不要。既存LINEチャネルのpush権限を使う実装上の判断であり、実端末や本番の到着を保証しない。LINEトークを開くリンクは届いたカードの位置へ直接移動する機能を持たない。

参照: [LINEのメッセージ送信](https://developers.line.biz/en/docs/messaging-api/sending-messages/)、[LINE URL scheme](https://developers.line.biz/en/docs/line-login/using-line-url-scheme/)。通常Chrome、架空の署名Webhook、実ローカルD1で検証し、外部API接続を遮断する。Libraryの片面チラシv3は変更しない。
