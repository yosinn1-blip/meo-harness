import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
import {sha256} from '../../worker/self-service/crypto.mjs';
let app,unexpected;
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')return r.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});if(u.origin===app.baseURL)return r.continue();unexpected.push(u.origin);return r.abort();});
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{autoButton:true,buttonConfirm:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
 app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='true';app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256=await sha256('alice');
});
test.afterEach(async({context})=>{try{expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toHaveLength(0);}finally{await context.close();await app.stop();}});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function accepted(page){
 await page.setViewportSize({width:375,height:812});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
 await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
 const code=await page.getByTestId('line-code').textContent();await fixture(page,'line',{code,userId:'line-fixture'});await page.getByRole('button',{name:'状態を更新',exact:true}).click();expect(app.pushes).toHaveLength(1);
 const s=await app.db.prepare('SELECT id FROM stores').first();await app.db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,3,?)').bind('test-day:'+s.id+':'+dateKeys(app.ctx.now()).day,app.ctx.now()+86400000).run();
}
async function snapshot(){return JSON.stringify(await Promise.all(['stores','line_links','line_checks','line_button_checks','line_check_deliveries','rate_limits','usage_budgets','usage_reservations'].map(async t=>[t,(await app.db.prepare('SELECT * FROM '+t).all()).results])));}
async function image(page,name){for(const width of [320,375,1280]){await page.setViewportSize({width,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`output/daily-owner-bypass/${name}-${width}.png`,fullPage:true});}}
const notice='本人の試用中は1日の回数制限を解除しています。1分に1回・共有の送信枠内で利用できます。';
test('approved owner sees correct temporary limit, can resend after existing 3/3, PIN switch still works',async({page})=>{
 await accepted(page);await fixture(page,'advance',{ms:300001});await page.reload();
 await expect(page.getByText(notice,{exact:true})).toBeVisible();await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeEnabled();await image(page,'owner-unlocked');
 const before=await snapshot();await page.reload();expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
 const [sent]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/button')),page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true}).click()]);expect(sent.ok()).toBe(true);expect(app.pushes).toHaveLength(2);
 await page.getByText('届かない・期限切れ・確認方法を切り替える',{exact:true}).click();await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();
 await fixture(page,'advance',{ms:60001});await page.reload();await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();
 const [pin]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/self/line/test')),page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true}).click()]);expect(pin.ok()).toBe(true);expect(app.pushes).toHaveLength(3);
 await expect(page.getByText(notice,{exact:true})).toBeVisible();await image(page,'owner-pin');
 const state=await (await page.request.get(app.baseURL+'/api/self/status')).json();expect(JSON.stringify(state)).not.toContain(app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256);expect(JSON.stringify(state)).not.toContain('ownerSub');expect(state.lineCheck.dailySendLimit).toBeNull();
});
test('minute cap still locks owner; turning bypass OFF restores same day 3/3 without DB reset',async({page})=>{
 await accepted(page);await page.reload();await expect(page.getByText(notice,{exact:true})).toBeVisible();await expect(page.getByText('確認メッセージの再送は少し待ってください。',{exact:true})).toBeVisible();
 await page.getByText('ボタンを使えない場合は番号で確認',{exact:true}).click();await expect(page.getByRole('button',{name:'番号で確認に切り替えて送る',exact:true})).toBeDisabled();await image(page,'owner-minute');
 const before=await snapshot();app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='false';await page.reload();await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toBeVisible();await expect(page.getByText(notice,{exact:true})).toHaveCount(0);expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
});
test('different owner digest keeps default limit and no temporary notice',async({page})=>{
 app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256=await sha256('bob');await accepted(page);await fixture(page,'advance',{ms:300001});await page.reload();
 await expect(page.getByText('今日は確認メッセージの送信上限（3回）に達しました。',{exact:true})).toBeVisible();await expect(page.getByText(notice,{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'確認メッセージをLINEに送る',exact:true})).toBeDisabled();expect(app.pushes).toHaveLength(1);
});
