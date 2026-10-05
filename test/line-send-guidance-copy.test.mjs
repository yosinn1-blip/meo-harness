import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('public FAQ agrees with current human-send CTA, card wait and original-browser explicit confirmation',()=>{
 const faq=readFileSync(new URL('../worker/self-service/ui/faq.html',import.meta.url),'utf8');
 const line=faq.split('<summary>登録の途中で、LINEに確認カードが届きません</summary>')[1].split('</details>')[0];
 assert.ok(line.includes('LINEを開いてコードを送る'));
 assert.ok(!line.includes('LINEを開く（コード入力済み）'));
 assert.ok(line.includes('入力欄の右側にある送信ボタン（矢印）を1回'));
 assert.ok(line.includes('自動送信はされません'));
 assert.ok(line.includes('開いただけでは登録されません'));
 assert.ok(line.includes('確認カードが届くまで待ち'));
 assert.ok(line.includes('確認して登録画面へ進む'));
 assert.ok(line.includes('通知先を確認して次へ'));
 assert.ok(line.includes('元のブラウザ'));
 assert.ok(line.includes('確認番号をLINEに送る'));
 assert.ok(line.includes('確認カードをもう一度送る'));
 assert.ok(line.includes('カードが届かない・期限が切れたとき'));
 assert.ok(line.includes('実際の上限は画面の表示に従'));
 assert.ok(!line.includes('自動送信が無効'));
 assert.ok(!line.includes('1 このLINEで確認'));
 assert.ok(!line.includes('本人試用中'));
});

// Production one-button screen: the expired card shows「確認カードをもう一度送る」as the
// main button; the number-only send always sits inside the collapsed recovery section.
test('FAQ LINE recovery names only controls the one-button screen really renders, in screen order',()=>{
 const faq=readFileSync(new URL('../worker/self-service/ui/faq.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../worker/self-service/ui/app.js.txt',import.meta.url),'utf8');
 const card=readFileSync(new URL('../worker/self-service/line-confirm-link.mjs',import.meta.url),'utf8');
 const line=faq.split('<summary>登録の途中で、LINEに確認カードが届きません</summary>')[1].split('</details>')[0];
 // Every quoted control is a real button/link/summary label on the screen, or the LINE card button.
 const quoted=[...new Set([...line.matchAll(/「([^」]+)」/g)].map(m=>m[1]))];
 assert.ok(quoted.length>=6,quoted.join(','));
 const oneCard=app.slice(app.indexOf('if (oneCard) {'),app.indexOf('if (sameBrowser && state.lineButtonConfirm && !fromLink && !state.lineOneButton)'));
 assert.ok(oneCard.includes('button("確認カードをもう一度送る"')&&oneCard.includes('button("確認番号をLINEに送る"')&&oneCard.includes('node("summary", "カードが届かない・期限が切れたとき")'));
 for(const name of quoted){
  const control=new RegExp('(?:button|link)\\("'+name+'"|node\\("summary", "'+name+'"\\)|button\\(fromLink \\? "'+name+'"|: "'+name+'", async').test(app)||card.includes('label:"'+name+'"');
  assert.ok(control,'FAQ names a control that the screen does not render: '+name);
 }
 // Recovery order follows the screen: card resend first, then the section, then number-only.
 const recovery=line.match(/<p>カードの期限が切れた場合は[^<]*<\/p>/)?.[0]??'';
 assert.ok(recovery,'expired-card recovery paragraph');
 const at=t=>recovery.indexOf('「'+t+'」');
 assert.ok(at('確認カードをもう一度送る')>=0&&at('確認カードをもう一度送る')<at('カードが届かない・期限が切れたとき'));
 assert.ok(at('カードが届かない・期限が切れたとき')<at('確認番号をLINEに送る'));
 assert.ok(!/届かない・期限が切れた場合は、元のブラウザで「確認番号をLINEに送る」/.test(line));
});
