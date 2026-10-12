import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
let app,unexpected;
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
  if(u.origin===app.baseURL)return route.continue();unexpected.push(u.origin);return route.abort('blockedbyclient');
 });
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{autoButton:true,buttonConfirm:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
});
test.afterEach(async({context})=>{try{expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toHaveLength(0);}finally{await context.close();await app.stop();}});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function accepted(page){
 await page.setViewportSize({width:375,height:812});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
 await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
 const code=await page.getByTestId('line-code').textContent();await fixture(page,'line',{code,userId:'line-fixture'});
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();expect(app.pushes).toHaveLength(1);
}
async function fullDay(){const s=await app.db.prepare('SELECT id FROM stores').first(),n=app.ctx.now();await app.db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,3,?)').bind('test-day:'+s.id+':'+dateKeys(n).day,n+86400000).run();}
async function snapshot(){return JSON.stringify(await Promise.all(['stores','line_links','line_checks','line_button_checks','line_check_deliveries','rate_limits','usage_budgets','usage_reservations','audit_events'].map(async t=>[t,(await app.db.prepare('SELECT * FROM '+t).all()).results])));}
async function image(page,stage){await expect(page.getByRole('button',{name:'状態を更新',exact:true})).toBeVisible();for(const width of [320,375,1280]){await page.setViewportSize({width,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`../output/meo-line-button-recovery-20261002/${process.env.MEO_RECOVERY_PHASE??'fixed'}-${stage}-${width}.png`,fullPage:true});}}
test('URI-only return stays unconfirmed and clearly sends the owner to card step one; polling adds no sends',async({page})=>{
 await accepted(page);let confirmPosts=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/self/line/confirm'))confirmPosts++;});
 const before=await snapshot();await page.goto(app.pushes[0].messages[0].contents.footer.contents[1].action.uri);
 await image(page,'unreceived');
 await expect(page.getByText('LINEの確認ボタンはまだ受け取っていません。',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'LINEのカードで「1 このLINEで確認」を押す',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);
 expect(await snapshot()).toBe(before);expect(confirmPosts).toBe(0);expect(app.pushes).toHaveLength(1);
});
test('expired card with daily limit blocks resend, PIN switch and code reissue while GETs leave all data unchanged',async({page})=>{
 await accepted(page);await fullDay();await fixture(page,'advance',{ms:300001});await page.reload();await image(page,'expired-daily');
 await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();
 await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 await expect(page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true})).toBeDisabled();
 await page.getByText('通知先のLINEを変更する・登録コードを送り直す',{exact:true}).click();
 await expect(page.getByRole('button',{name:'コードを再発行',exact:true})).toBeDisabled();
 const before=await snapshot();await page.reload();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
 await fixture(page,'advance',{ms:600001});await purgeExpired(app.ctx);await page.reload();await image(page,'link-missing-daily');
 await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true})).toBeDisabled();
 const retained=await snapshot();await page.reload();expect(await snapshot()).toBe(retained);expect(app.pushes).toHaveLength(1);
});
test('daily limit does not block receipt and owner confirmation from the current still-live card',async({page})=>{
 await accepted(page);await fullDay();const action=app.pushes[0].messages[0].contents.footer.contents[0].action.data;
 await fixture(page,'postback',{action,userId:'line-fixture'});await page.reload();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeEnabled();await image(page,'received-daily');
 await page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click();await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
 expect((await app.db.prepare('SELECT terms_version FROM stores').first()).terms_version).toBeNull();expect(app.pushes).toHaveLength(1);
});
test('old replaced card is acknowledged by webhook but does not confirm the live replacement; correct receipt updates on return',async({page})=>{
 await accepted(page);const old=app.pushes[0].messages[0].contents.footer.contents[0].action.data;
 await fixture(page,'advance',{ms:60001});await page.reload();
 await page.getByText('届かない・期限切れ・確認方法を切り替える',{exact:true}).click();
 const [sent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/button')),
  page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true}).click()]);expect(sent.ok()).toBe(true);expect(app.pushes).toHaveLength(2);
 const before=await snapshot();expect((await fixture(page,'postback',{action:old,userId:'line-fixture'})).status()).toBe(200);
 await page.reload();expect(await snapshot()).toBe(before);
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);
 const current=app.pushes[1].messages[0].contents.footer.contents[0].action.data;
 await fixture(page,'postback',{action:current,userId:'line-fixture'});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(2);
});
for(const expired of [false,true])test('PIN fallback daily cap keeps only a live PIN actionable, expired '+expired,async({page})=>{
 await accepted(page);await fixture(page,'advance',{ms:60001});await page.reload();
 await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 const [sent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/test')),
  page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true}).click()]);expect(sent.ok()).toBe(true);
 const pin=(await (await fixture(page,'pin')).json()).pin;await fullDay();if(expired)await fixture(page,'advance',{ms:300001});await page.reload();
 await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'確認番号をLINEに送る',exact:true})).toBeDisabled();
 await page.getByText('番号を入力せずボタンで確認する',{exact:true}).click();
 await expect(page.getByRole('button',{name:'ボタン確認へ切り替えて送る',exact:true})).toBeDisabled();
 if(expired){await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'確認する',exact:true})).toHaveCount(0);await image(page,'expired-pin-daily');}
 else {await page.getByLabel('確認番号',{exact:true}).fill(pin);await page.getByRole('button',{name:'確認する',exact:true}).click();await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();}
 expect(app.pushes).toHaveLength(2);
});
test('manual PIN expiry is noticed on the open page without a daily limit, reload or extra send',async({page})=>{
 await accepted(page);await fixture(page,'advance',{ms:60001});await page.reload();
 await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 const [sent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/test')),
  page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true}).click()]);expect(sent.ok()).toBe(true);
 await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();
 const before=await snapshot();await fixture(page,'advance',{ms:300001});await page.clock.install({time:new Date(app.ctx.now())});
 await page.clock.runFor(3001);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'確認する',exact:true})).toHaveCount(0);
 expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(2);
});
test('minute limit ending preserves live PIN entry and focus without changing the challenge or sending again',async({page})=>{
 await accepted(page);await fixture(page,'advance',{ms:60001});await page.reload();
 await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 const [sent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/test')),
  page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true}).click()]);expect(sent.ok()).toBe(true);
 const input=page.getByLabel('確認番号',{exact:true});await input.fill('123');await input.focus();
 const before=await snapshot();await fixture(page,'advance',{ms:60001});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByRole('button',{name:'確認番号をLINEに送る',exact:true})).toBeEnabled();
 await expect(input).toHaveValue('123');await expect(input).toBeFocused();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(2);
 const pin=(await (await fixture(page,'pin')).json()).pin;await input.fill(pin);await page.getByRole('button',{name:'確認する',exact:true}).click();
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
});
