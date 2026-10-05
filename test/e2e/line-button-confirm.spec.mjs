import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
import {purgeExpired} from '../../worker/self-service/retention.mjs';
let app,unexpected,extraContexts;
async function configure(context){
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')
   return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
  if(u.origin===app.baseURL)return route.continue();
  unexpected.push(u.origin);return route.abort('blockedbyclient');
 });
}
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];extraContexts=[];await configure(context);
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{buttonConfirm:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
});
test.afterEach(async({context})=>{
 try {expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toHaveLength(0);}
 finally {for(const c of extraContexts)await c.close();await context.close();await app.stop();}
});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function ready(page){
 await page.setViewportSize({width:375,height:812});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
 await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();
 await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
 const code=await page.getByTestId('line-code').textContent();
 await fixture(page,'line',{code,userId:'line-fixture'});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
}
async function send(page){
 await page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true}).click();
 await expect(page.getByRole('link',{name:'LINEのカードで「1 このLINEで確認」を押す',exact:true})).toBeVisible();
}
const action=()=>app.pushes.at(-1).messages[0].contents.footer.contents[0].action.data;
async function receipt(page,data=action(),userId='line-fixture'){
 await fixture(page,'postback',{action:data,userId});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'状態を更新',exact:true})).toBeEnabled();
}
async function snapshot(){
 const tables=(await app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
 return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await app.db.prepare('SELECT * FROM "'+name+'"').all()).results])));
}
async function screens(page,stage){
 for(const [width,name] of [[320,'320'],[375,'375'],[1280,'1280']]){
  await page.setViewportSize({width,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`output/self-service/button-${stage}-${name}.png`,fullPage:true});
 }await page.setViewportSize({width:375,height:812});
}
for(const buttonConfirm of [true,false]) test('original browser after link retention shows explicit recovery, no automatic send, button mode '+buttonConfirm,async({page})=>{
 await fixture(page,'scenario',{buttonConfirm});await ready(page);
 const sendName=buttonConfirm?'確認メッセージをLINEに送る':'確認番号をLINEに送る';
 await expect(page.getByRole('button',{name:sendName,exact:true})).toBeVisible();
 await fixture(page,'advance',{ms:900001});await purgeExpired(app.ctx);
 const before=await snapshot();await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true})).toBeVisible();
 await expect(page.getByText('LINEは検出していますが、通知先の確認をやり直す必要があります。',{exact:true})).toBeVisible();
 await expect(page.getByText('設定を始めたブラウザへ戻ってください。そちらを使えない場合は、下の補助欄でコードを再発行し、LINEへ送り直してください。',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:sendName,exact:true})).toHaveCount(0);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
 await page.locator('#setup-account-actions > summary').click();
 await expect(page.getByRole('button',{name:'接続を切断',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true})).toBeVisible();
 expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(0);
 if(buttonConfirm)await screens(page,'link-missing');
 await page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true}).click();
 await expect(page.getByRole('link',{name:'LINEを開いてコードを送る',exact:true})).toBeVisible();
 await expect(page.getByTestId('line-code')).toHaveText(/^MEOS-[A-HJ-NP-Z2-9]{12}$/);
 const code=await page.getByTestId('line-code').textContent();await fixture(page,'line',{code,userId:'line-fixture'});
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByRole('button',{name:sendName,exact:true})).toBeVisible();expect(app.pushes).toHaveLength(0);
});
test('return after missing link remains private and read-only; normal original start offers recovery',async({page})=>{
 await ready(page);await fixture(page,'advance',{ms:900001});await purgeExpired(app.ctx);
 const before=await snapshot();await page.goto(app.baseURL+'/start?openExternalBrowser=1');
 await expect(page.getByRole('heading',{name:'登録を始めた画面へ戻ってください',exact:true})).toBeVisible();
 await expect(page.getByText('架空美容室',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true})).toHaveCount(0);
 const status=await (await page.request.get(app.baseURL+'/api/self/line/return-status')).json();
 expect(status).toEqual({ok:true,state:'line_return_mismatch',csrf:null});
 expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(0);
 await page.goto(app.baseURL+'/start');
 await expect(page.getByRole('button',{name:'LINEの登録コードを再発行',exact:true})).toBeVisible();
 expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(0);
});
test('separate LINE session confirms; wrong return stays generic; original owner and terms stay explicit',async({page,browser})=>{
 await ready(page);expect(app.pushes).toHaveLength(0);await send(page);await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
 await screens(page,'waiting');const line=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812}});extraContexts.push(line);await configure(line);
 const lp=await line.newPage();await lp.goto(app.baseURL+'/fixture/line-card');await lp.getByRole('button',{name:'1 このLINEで確認',exact:true}).click();
 await expect(lp.getByText('架空署名イベントを処理しました',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_pending');
 const before=await snapshot();await lp.getByRole('link',{name:'2 登録画面へ戻る',exact:true}).click();
 await expect(lp.getByRole('heading',{name:'登録を始めた画面へ戻ってください',exact:true})).toBeVisible();
 await lp.reload();await expect(lp.getByRole('heading',{name:'登録を始めた画面へ戻ってください',exact:true})).toBeVisible();
 expect(await snapshot()).toBe(before);expect(await line.cookies()).toHaveLength(0);
 await lp.screenshot({path:'output/self-service/button-wrong-return-375.png',fullPage:true});
 const uri=app.pushes[0].messages[0].contents.footer.contents[1].action.uri;
 expect(new URL(uri).search).toBe('?openExternalBrowser=1');
 // OS launch is emulated by navigating the original context; no cookie transfer.
 await page.goto(uri);await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();
 expect(await snapshot()).toBe(before);await screens(page,'receipt');
 await page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click();
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
 let activates=0;page.on('request',r=>{if(r.url().endsWith('/api/self/activate'))activates++;});
 await page.getByRole('button',{name:'利用を開始する',exact:true}).click();
 await expect(page.getByLabel('利用条件を確認しました')).toBeFocused();expect(activates).toBe(0);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');
 await page.getByLabel('利用条件を確認しました').check();await page.getByRole('button',{name:'利用を開始する',exact:true}).click();
 await expect(page.getByRole('heading',{name:'稼働中',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);
});
test('PIN fallback is explicit and old button is rejected; switching back invalidates old PIN',async({page})=>{
 await ready(page);await send(page);const old=action();await receipt(page);await expect(page.getByRole('button',{name:'通知先を確認して次へ'})).toBeVisible();
 await fixture(page,'advance',{ms:60001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true,includeHidden:true})).toBeEnabled();await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 await page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true}).click();
 await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();const pin=(await (await fixture(page,'pin')).json()).pin;
 await receipt(page,old);await expect(page.getByRole('button',{name:'通知先を確認して次へ'})).toHaveCount(0);
 await fixture(page,'advance',{ms:60001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'ボタン確認へ切り替えて送る',exact:true,includeHidden:true})).toBeEnabled();await page.getByText('番号を入力せずボタンで確認する',{exact:true}).click();
 await page.getByRole('button',{name:'ボタン確認へ切り替えて送る',exact:true}).click();
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
 const csrf=(await (await page.request.get(app.baseURL+'/api/self/status')).json()).csrf;
 const denied=await page.request.post(app.baseURL+'/api/self/line/verify',{data:{pin},headers:{Origin:app.baseURL,'X-CSRF-Token':csrf}});expect(denied.status()).toBe(400);
 await receipt(page);await page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click();
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(3);
});
for(const scenario of [{name:'quota-full',settings:{quota:0}},{name:'quota-unknown',settings:{quota:'invalid'}},{name:'provider-rejected',settings:{lineFailure:'failed'}}])
 test('unsent '+scenario.name+' stays in browser with visible send recovery',async({page})=>{
  await ready(page);await fixture(page,'scenario',scenario.settings);
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/button')),
    page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true}).click()]);
  expect(response.ok()).toBe(false);await expect(page.locator('#error')).toBeVisible();
  await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();
  await fixture(page,'advance',{ms:60001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
  await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'LINEのカードで「1 このLINEで確認」を押す'})).toHaveCount(0);
  await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
  expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_pending');
  expect(app.pushes).toHaveLength(scenario.name==='provider-rejected'?1:0);
 });
test('expiry and scheduled cleanup retain button mode without a PIN input',async({page})=>{
 await ready(page);await send(page);await fixture(page,'advance',{ms:300001});await purgeExpired(app.ctx);
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeVisible();
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'通知先を確認して次へ'})).toHaveCount(0);
 expect(app.pushes).toHaveLength(1);await screens(page,'expired');
});
test('unknown delivery keeps one reservation and card; actual receipt can still continue',async({page})=>{
 await ready(page);await fixture(page,'scenario',{lineFailure:'unknown'});await send(page);
 await expect(page.getByText('送信結果を確認できません。届いたボタンは期限内なら使えます。自動では再送しません。',{exact:true})).toBeVisible();
 expect((await app.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='uncertain'").first()).n).toBe(2);
 await receipt(page);await page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click();
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);
});
test('both flags ON preserve automatic PIN and disable the manual button route',async({page})=>{
 await fixture(page,'scenario',{autoPin:true});await ready(page);
 await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);expect(app.pushes[0].messages[0].type).toBe('text');
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る'})).toHaveCount(0);
 const csrf=(await (await page.request.get(app.baseURL+'/api/self/status')).json()).csrf;
 const r=await page.request.post(app.baseURL+'/api/self/line/button',{data:{},headers:{Origin:app.baseURL,'X-CSRF-Token':csrf}});expect(r.status()).toBe(409);
});
