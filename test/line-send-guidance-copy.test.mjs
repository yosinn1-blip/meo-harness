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
 assert.ok(line.includes('実際の上限は画面の表示に従'));
 assert.ok(!line.includes('自動送信が無効'));
 assert.ok(!line.includes('1 このLINEで確認'));
 assert.ok(!line.includes('本人試用中'));
});
