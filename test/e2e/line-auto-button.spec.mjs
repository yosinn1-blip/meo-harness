import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
let app,unexpected,extraContexts;
async function configure(context){
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')
   return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
  if(u.origin===app.baseURL)return route.continue();unexpected.push(u.origin);return route.abort('blockedbyclient');
 });
}
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];extraContexts=[];await configure(context);
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{autoButton:true,buttonConfirm:true,autoPin:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
});
test.afterEach(async({context})=>{
 try {expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toHaveLength(0);}
 finally {for(const c of extraContexts)await c.close();await context.close();await app.stop();}
});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function codeReady(page){
 await page.setViewportSize({width:375,height:812});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
 await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
 await expect(page.getByText('2. LINEのカードで確認して戻る',{exact:true})).toBeVisible();
 return page.getByTestId('line-code').textContent();
}
async function accept(page){const code=await codeReady(page);await fixture(page,'line',{code,userId:'line-fixture'});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByRole('link',{name:'LINEで確認メッセージを開く',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);expect(app.pushes[0].messages[0].type).toBe('flex');}
const card=()=>app.pushes.at(-1).messages[0];
const action=()=>card().contents.footer.contents[0].action.data;
async function snapshot(){const tables=(await app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await app.db.prepare('SELECT * FROM "'+name+'"').all()).results])));}
async function screens(page,stage){for(const [width,name] of [[320,'320'],[375,'375'],[1280,'1280']]){await page.setViewportSize({width,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`../output/meo-line-auto-button-20261002/auto-${stage}-${name}.png`,fullPage:true});}await page.setViewportSize({width:375,height:812});}
test('one LINE visit: code send presents card; return alone does nothing; ordered receipt still requires owner finalization and terms',async({page,browser})=>{
 const code=await codeReady(page);await screens(page,'code');
 const line=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812}});extraContexts.push(line);await configure(line);
 const lp=await line.newPage();await lp.goto(app.baseURL+'/fixture/line-chat');await lp.getByLabel('登録コード',{exact:true}).fill(code);
 await lp.getByRole('button',{name:'LINEへコード送信（架空）',exact:true}).click();
 await expect(lp.getByRole('button',{name:'1 このLINEで確認',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);
 await lp.screenshot({path:'../output/meo-line-auto-button-20261002/auto-fixture-card-375.png',fullPage:true});
 const uri=card().contents.footer.contents[1].action.uri;
 let automaticConfirm=0;page.on('request',r=>{if(r.method()==='POST'&&/\/api\/self\/(line\/confirm|activate)$/.test(new URL(r.url()).pathname))automaticConfirm++;});
 const before=await snapshot();await page.goto(uri);
 await expect(page.getByRole('link',{name:'LINEで確認メッセージを開く',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveCount(0);
 await page.reload();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);expect(automaticConfirm).toBe(0);await screens(page,'premature-return');
 await lp.getByRole('button',{name:'1 このLINEで確認',exact:true}).click();await expect(lp.getByText('架空署名イベントを処理しました',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();expect(automaticConfirm).toBe(0);
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toMatchObject({state:'line_pending',terms_version:null});
 const received=await snapshot();await lp.getByRole('link',{name:'2 登録画面へ戻る',exact:true}).click();
 await expect(lp.getByRole('heading',{name:'登録を始めた画面へ戻ってください',exact:true})).toBeVisible();expect(await line.cookies()).toHaveLength(0);expect(await snapshot()).toBe(received);
 await page.goto(uri);await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();expect(await snapshot()).toBe(received);await screens(page,'receipt');
 await page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click();await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'利用を開始する',exact:true}).click();await expect(page.getByLabel('利用条件を確認しました')).toBeFocused();expect(automaticConfirm).toBe(1);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');
 await page.getByLabel('利用条件を確認しました').check();await page.getByRole('button',{name:'利用を開始する',exact:true}).click();
 await expect(page.getByRole('heading',{name:'稼働中',exact:true})).toBeVisible();expect(app.pushes).toHaveLength(1);
});
test('five-minute expiry is visible; reload never resends; explicit new card invalidates old receipt',async({page})=>{
 await accept(page);const old=action();await fixture(page,'advance',{ms:300001});await page.reload();
 await expect(page.getByText('確認カードの5分間の期限が切れました。「確認メッセージをLINEに送る」を押して、新しいカードで確認してください。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeVisible();
 const before=await snapshot();await fixture(page,'postback',{action:old,userId:'line-fixture'});await page.reload();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);await screens(page,'expired');
 const [resent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/button')),
  page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true}).click()]);expect(resent.ok()).toBe(true);expect(app.pushes).toHaveLength(2);
 await fixture(page,'postback',{action:old,userId:'line-fixture'});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);
 await fixture(page,'postback',{action:action(),userId:'line-fixture'});await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();
});
test('missing automatic claim is bounded read-only awaiting then explicit recovery',async({page})=>{
 await accept(page);
 // Simulate a lost worker task marker after intake using the real fixture DB.
 await app.db.prepare('DELETE FROM line_check_deliveries').run();
 const before=await snapshot();await page.reload();
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();await screens(page,'awaiting');
 await page.reload();await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();expect(await snapshot()).toBe(before);
 await fixture(page,'advance',{ms:20001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeEnabled();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
});
for(const scenario of [{name:'quota-full',settings:{quota:0},pushes:0},{name:'provider-rejected',settings:{lineFailure:'failed'},pushes:1}])
 test('automatic '+scenario.name+' provides explicit recovery with no retry on reload',async({page})=>{
  await fixture(page,'scenario',scenario.settings);const code=await codeReady(page);await fixture(page,'line',{code,userId:'line-fixture'});await page.reload();
  await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toHaveCount(0);
  const before=await snapshot();await page.reload();await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeVisible();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(scenario.pushes);
 });
test('unknown automatic delivery retains card and reservation, allows actual receipt, never repeats automatically',async({page})=>{
 await fixture(page,'scenario',{lineFailure:'unknown'});await accept(page);
 await expect(page.getByText('送信結果を確認できません。届いたボタンは期限内なら使えます。自動では再送しません。',{exact:true})).toBeVisible();
 const before=await snapshot();await page.reload();await expect(page.getByRole('link',{name:'LINEで確認メッセージを開く',exact:true})).toBeVisible();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
 expect((await app.db.prepare("SELECT count(*) n FROM usage_reservations WHERE state='uncertain' AND kind='push'").first()).n).toBe(1);
 await fixture(page,'postback',{action:action(),userId:'line-fixture'});await expect(page.getByRole('button',{name:'通知先を確認して次へ',exact:true})).toBeVisible();
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_pending');
});
