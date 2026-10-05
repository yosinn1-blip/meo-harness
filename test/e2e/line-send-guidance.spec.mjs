import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';

const openName='LINEを開いてコードを送る';
const sendHelp='LINEが開いたら、入力欄の右側にある送信ボタン（矢印）を1回押してください。開いただけでは登録されません。';
const waitingHelp='送信後はLINEのトークで確認カードが届くまで待ち、「確認して登録画面へ進む」を押してください。';
const friendHelp='初回は、まず友だち追加の画面が出ます。追加したら、この画面に戻って同じボタンをもう一度押してください。';
let app,unexpected,requests;
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];requests=[];
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
  if(u.origin===app.baseURL){requests.push({method:r.method(),url:r.url()});return route.continue();}
  unexpected.push(u.origin);return route.abort('blockedbyclient');
 });
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{autoButton:true,buttonConfirm:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
 app.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='true';
});
test.afterEach(async({context})=>{
 try{expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toEqual([]);}
 finally{await context.close();await app.stop();}
});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function prepare(page,width=375){
 await page.setViewportSize({width,height:900});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
 await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();
 await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
 const code=await page.getByTestId('line-code').textContent();requests=[];return code;
}
const open=page=>page.getByRole('link',{name:openName,exact:true});
async function notReceived(page){
 const status=await(await page.request.get(app.baseURL+'/api/self/status')).json();
 expect(status.state).toBe('line_pending');expect(status.lineDetected).toBe(false);expect(status.lineVerified).toBe(false);
 const store=await app.db.prepare('SELECT pending_line_user_id,line_user_id,line_verified_at,terms_version FROM stores').first();
 expect(store).toEqual({pending_line_user_id:null,line_user_id:null,line_verified_at:null,terms_version:null});
 expect((await app.db.prepare('SELECT count(*) n FROM line_checks').first()).n).toBe(0);
 expect(app.pushes).toEqual([]);expect(requests.filter(r=>r.method!=='GET'&&new URL(r.url).pathname.startsWith('/api/self/'))).toEqual([]);
}
for(const width of [320,375,1280])test(`human send instruction is prominent beside the primary LINE link at ${width}px`,async({page})=>{
 const code=await prepare(page,width),instruction=page.getByText(sendHelp,{exact:true});
 await expect(instruction).toBeVisible();await expect(instruction).toHaveClass('next-action');
 await expect(open(page)).toBeVisible();await expect(page.getByText(waitingHelp,{exact:true})).toBeVisible();
 const presentation=await instruction.evaluate(e=>({weight:Number(getComputedStyle(e).fontWeight),border:Number.parseFloat(getComputedStyle(e).borderLeftWidth),before:!!(e.compareDocumentPosition(document.querySelector('a[href*="oaMessage/"]'))&Node.DOCUMENT_POSITION_FOLLOWING)}));
 expect(presentation.weight).toBeGreaterThanOrEqual(600);expect(presentation.border).toBeGreaterThanOrEqual(3);expect(presentation.before).toBe(true);
 const friend=page.getByText(friendHelp,{exact:true});await expect(friend).toBeVisible();await expect(friend).toHaveClass('next-action');
 expect(await friend.evaluate((e,text)=>!!(e.compareDocumentPosition([...document.querySelectorAll('p')].find(p=>p.textContent===text))&Node.DOCUMENT_POSITION_FOLLOWING),sendHelp)).toBe(true);
 await expect(page.getByText('アプリ切替',{exact:false})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'まず、LINEでコードを送る',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const url=new URL(await open(page).getAttribute('href'));expect(url.origin).toBe('https://line.me');expect(url.pathname).toBe('/R/oaMessage/%40fixture/');expect(decodeURIComponent(url.search.slice(1))).toBe(code);
 await notReceived(page);await page.screenshot({path:`output/line-send-guidance/guidance-${width}.png`,fullPage:true});
});

test('one shared refresh control keeps an unsent LINE code pending without sending or registering',async({page})=>{
 const code=await prepare(page),refresh=page.getByRole('button',{name:'状態を更新',exact:true});
 await expect(page.getByRole('button',{name:/状態を更新$/})).toHaveCount(1);await expect(refresh).toBeVisible();
 const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith('/api/self/status')),refresh.click()]);
 expect(response.ok()).toBe(true);await expect(refresh).toBeEnabled();
 await expect(page.getByRole('button',{name:/状態を更新$/})).toHaveCount(1);
 await expect(page.getByTestId('line-code')).toHaveText(code);await expect(open(page)).toBeVisible();
 await expect(page.getByText('LINEから登録コードをまだ受け取っていません。',{exact:true})).toBeVisible();
 // The not-received line sits with the refresh hint, directly above the one refresh control.
 expect(await page.getByText('LINEから登録コードをまだ受け取っていません。',{exact:true}).evaluate(e=>[e.nextElementSibling?.textContent,e.nextElementSibling?.nextElementSibling?.textContent])).toEqual(['通常は自動で検出します。画面が変わらないときだけ、状態を更新してください。','状態を更新']);
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toHaveCount(0);
 await notReceived(page);
});

test('the same single refresh reveals a signed LINE message without confirming or resending',async({page})=>{
 const code=await prepare(page),refresh=page.getByRole('button',{name:'状態を更新',exact:true});
 await expect(page.getByRole('button',{name:/状態を更新$/})).toHaveCount(1);await notReceived(page);
 expect((await fixture(page,'line',{code,userId:'line-shared-refresh-fixture'})).ok()).toBe(true);expect(app.pushes).toHaveLength(1);
 const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith('/api/self/status')),refresh.click()]);
 expect(response.ok()).toBe(true);expect(await response.json()).toMatchObject({state:'line_pending',lineDetected:true,lineVerified:false});
 await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue('');
 await expect(open(page)).toHaveCount(0);await expect(page.getByRole('button',{name:/状態を更新$/})).toHaveCount(1);await expect(refresh).toBeVisible();
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toHaveCount(0);
 expect(await app.db.prepare('SELECT state,line_user_id,line_verified_at,terms_version FROM stores').first()).toEqual({state:'line_pending',line_user_id:null,line_verified_at:null,terms_version:null});
 expect((await app.db.prepare('SELECT count(*) n FROM line_checks').first()).n).toBe(1);
 expect(app.pushes).toHaveLength(1);expect(requests.filter(r=>r.method!=='GET'&&new URL(r.url).pathname.startsWith('/api/self/'))).toEqual([]);
});

test('opening LINE and returning without sending remains unreceived and performs no confirmation writes',async({page,context})=>{
 const code=await prepare(page);let opened=0;
 await context.route('https://line.me/R/oaMessage/**',async route=>{
  opened++;expect(decodeURIComponent(new URL(route.request().url()).search.slice(1))).toBe(code);expect(route.request().headers()['referer']).toBeUndefined();
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><h1>架空LINEトーク</h1><p>コードは入力済み・送信前</p>'});
 });
 const original=page.url(),popupPromise=page.waitForEvent('popup');await open(page).click();const popup=await popupPromise;await popup.waitForLoadState();
 expect(opened).toBe(1);expect(page.url()).toBe(original);await notReceived(page);await popup.close();
 const read=page.waitForResponse(r=>r.url().endsWith('/api/self/status'));
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await read;
 await expect(page.getByText('LINEから登録コードをまだ受け取っていません。',{exact:true})).toBeVisible();
 await expect(page.getByText(sendHelp,{exact:true})).toBeVisible();await notReceived(page);
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();await notReceived(page);
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'送信しました',exact:true})).toHaveCount(0);
});

test('only a signed fixture code message delivers the one-button card and explicit original-browser next verifies',async({page})=>{
 const code=await prepare(page);await expect(page.getByText(sendHelp,{exact:true})).toBeVisible();await notReceived(page);
 expect((await fixture(page,'line',{code,userId:'line-send-guidance-fixture'})).ok()).toBe(true);expect(app.pushes).toHaveLength(1);
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 const message=app.pushes[0].messages[0],buttons=message.contents.footer.contents.filter(x=>x.type==='button');expect(buttons).toHaveLength(1);
 expect(buttons[0].action.type).toBe('uri');expect(buttons[0].action.label).toBe('確認して登録画面へ進む');
 const uri=new URL(buttons[0].action.uri),pin=new URLSearchParams(uri.hash.slice(1)).get('line-confirm');expect(pin).toMatch(/^\d{6}$/);
 expect(uri.origin).toBe(app.baseURL);requests=[];await page.goto(uri.href);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(pin);expect(page.url()).not.toContain('line-confirm');
 expect(requests.filter(r=>r.method!=='GET'&&new URL(r.url).pathname.startsWith('/api/self/'))).toEqual([]);
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toEqual({state:'line_pending',terms_version:null});
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/verify')),page.getByRole('button',{name:'通知先を確認して次へ',exact:true}).click()]);expect(response.ok()).toBe(true);
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toEqual({state:'line_verified',terms_version:null});
 expect(app.pushes).toHaveLength(1);expect(requests.filter(r=>r.method==='POST'&&r.url.endsWith('/api/self/activate'))).toEqual([]);
});
