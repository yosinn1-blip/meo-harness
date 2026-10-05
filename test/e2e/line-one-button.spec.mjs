import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
import {createSession} from '../../worker/self-service/session.mjs';
import {sha256} from '../../worker/self-service/crypto.mjs';
import {dateKeys} from '../../worker/self-service/contracts.mjs';
let app,unexpected,extraContexts,requests;
const nextName='通知先を確認して次へ';
async function configure(context){
 await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
 await context.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname==='/turnstile/v0/api.js')return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
  if(u.origin===app.baseURL){requests.push({method:request.method(),url:request.url(),body:request.postData()});return route.continue();}
  unexpected.push(u.origin);return route.abort('blockedbyclient');
 });
}
test.beforeEach(async({context})=>{
 app=await startTestApp();unexpected=[];extraContexts=[];requests=[];await configure(context);
 await context.request.post(app.baseURL+'/fixture/scenario',{data:{autoButton:true,buttonConfirm:true,lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey}});
 app.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='true';
});
test.afterEach(async({context})=>{
 try{expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);expect(app.writes).toHaveLength(0);
  for(const request of requests.filter(r=>r.method==='GET')){const u=new URL(request.url);expect(u.hash).toBe('');expect(u.searchParams.has('line-confirm')).toBe(false);expect(u.searchParams.has('pin')).toBe(false);}
 }finally{for(const c of extraContexts)await c.close();await context.close();await app.stop();}
});
const fixture=(page,path,data={})=>page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
async function accepted(page){
 await page.setViewportSize({width:375,height:812});await page.goto(app.baseURL+'/start');
 await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();
 await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();const code=await page.getByTestId('line-code').textContent();
 await fixture(page,'line',{code,userId:'line-fixture'});await page.getByRole('button',{name:'状態を更新',exact:true}).click();expect(app.pushes).toHaveLength(1);
 const card=app.pushes[0].messages[0];expect(card.type).toBe('flex');const buttons=card.contents.footer.contents.filter(c=>c.type==='button');expect(buttons).toHaveLength(1);
 expect(buttons[0].action.type).toBe('uri');expect(buttons[0].action.label).toBe('確認して登録画面へ進む');const uri=new URL(buttons[0].action.uri);
 expect(uri.origin).toBe(app.ctx.env.SELF_PUBLIC_ORIGIN);expect(uri.pathname).toBe('/start');expect(uri.search).toBe('?openExternalBrowser=1');
 const parts=new URLSearchParams(uri.hash.slice(1));expect([...parts.keys()]).toEqual(['line-confirm','store','expires']);const pin=parts.get('line-confirm');expect(pin).toMatch(/^\d{6}$/);
 const store=await app.db.prepare('SELECT id,state,terms_version FROM stores').first();expect(parts.get('store')).toBe(store.id);expect(Number(parts.get('expires'))).toBeGreaterThan(app.ctx.now());
 expect(card.contents.body.contents.filter(c=>c.type==='text').map(c=>c.text).join('\n')).toContain(pin);
 // Mirror the configured card URI to this exact local fixture origin, never real LINE.
 uri.protocol=new URL(app.baseURL).protocol;uri.host=new URL(app.baseURL).host;requests=[];
 return {uri:uri.href,pin,store:store.id,expires:Number(parts.get('expires'))};
}
async function clickCard(page,uri){
 await page.evaluate(({uri})=>{const link=document.createElement('a');link.textContent='確認して登録画面へ進む';link.href=uri;document.body.replaceChildren(link);},{uri});
 await page.getByRole('link',{name:'確認して登録画面へ進む',exact:true}).click();
}
async function noStoredPin(page,pin){
 expect(await page.evaluate(()=>location.hash)).toBe('');expect(page.url()).not.toContain('line-confirm');
 const values=await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)]);expect(values.some(v=>v.includes(pin)||v.includes('line-confirm'))).toBe(false);
}
const confirmPosts=()=>requests.filter(r=>r.method==='POST'&&/\/api\/self\/(line\/(verify|confirm)|activate)$/.test(new URL(r.url).pathname));
async function snapshot(){const tables=(await app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;return JSON.stringify(await Promise.all(tables.map(async({name})=>[name,(await app.db.prepare('SELECT * FROM "'+name+'"').all()).results])));}
async function emptyPin(page){await expect(page.locator('#current-step h2').first()).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.querySelector('#pin')?.value??'')).toBe('');}
async function screens(page,stage){for(const width of [320,375,1280]){await page.setViewportSize({width,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`output/line-one-button/${stage}-${width}.png`,fullPage:true});}await page.setViewportSize({width:375,height:812});}
function changed(uri,change){const u=new URL(uri),parts=new URLSearchParams(u.hash.slice(1));change(parts,u);u.hash=parts.toString();return u.href;}
async function post(page,path,body={}){const state=await(await page.request.get(app.baseURL+'/api/self/line/return-status')).json();return page.request.post(app.baseURL+'/api/self/'+path,{data:body,headers:{Origin:app.baseURL,'X-CSRF-Token':state.csrf}});}

test('one URI card click prefills only RAM and requires explicit next before LINE verification',async({page})=>{
 const data=await accepted(page),before=await snapshot();await clickCard(page,data.uri);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await expect(page.getByRole('button',{name:nextName,exact:true})).toBeVisible();await noStoredPin(page,data.pin);
 expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);expect(await snapshot()).toBe(before);
 expect(requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname==='/api/self/status')).toHaveLength(0);
 const status=await(await page.request.get(app.baseURL+'/api/self/line/return-status')).json();expect(status.state).toBe('line_pending');expect(status.lineCheck.pinAvailable).toBe(true);
 expect(JSON.stringify(status)).not.toContain('line-confirm=');expect(Object.values(status.lineCheck).includes(data.pin)).toBe(false);await screens(page,'prefilled');
 const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/verify'),page.getByRole('button',{name:nextName,exact:true}).click()]);expect(response.ok()).toBe(true);
 await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();expect(confirmPosts()).toHaveLength(1);
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toEqual({state:'line_verified',terms_version:null});expect(app.pushes).toHaveLength(1);await screens(page,'verified');
 await page.getByRole('button',{name:'利用を開始する',exact:true}).click();expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');
});
test('reload, actual history back/forward and persisted pageshow never resurrect fragment prefill',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await page.reload();await emptyPin(page);await noStoredPin(page,data.pin);
 await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await page.goto(app.baseURL+'/self/help/faq');await page.goBack();await emptyPin(page);
 await page.goForward();await page.goBack();await emptyPin(page);
 await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);
 await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await emptyPin(page);await noStoredPin(page,data.pin);
 expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);
});
test('malformed, duplicate, missing return marker, wrong store and expiry fragment metadata fail closed',async({page})=>{
 const data=await accepted(page),before=await snapshot();const cases=[
  changed(data.uri,p=>p.set('line-confirm','12345')),changed(data.uri,p=>p.set('line-confirm','１２３４５６')),
  changed(data.uri,p=>p.append('line-confirm',data.pin)),changed(data.uri,p=>p.append('store',data.store)),changed(data.uri,p=>p.append('expires',String(data.expires))),
  changed(data.uri,p=>p.delete('store')),changed(data.uri,p=>p.delete('expires')),
  changed(data.uri,p=>p.set('store','different-store')),changed(data.uri,p=>p.set('expires',String(data.expires+1))),changed(data.uri,p=>p.set('expires','1')),
  changed(data.uri,(_p,u)=>u.search=''),
 ];
 for(const uri of cases){await page.goto(uri);await emptyPin(page);await noStoredPin(page,data.pin);expect(confirmPosts()).toHaveLength(0);}
 expect(await snapshot()).toBe(before);expect(app.pushes).toHaveLength(1);
});
test('anonymous, same owner other session and another owner receive generic return with no prefill',async({page,browser})=>{
 const data=await accepted(page);
 for(const sub of [null,'alice','bob']){
  const context=await browser.newContext({ignoreHTTPSErrors:true});extraContexts.push(context);await configure(context);
  if(sub){const session=await createSession(app.ctx,sub);const pair=session.cookie.split(';')[0],i=pair.indexOf('=');await context.addCookies([{name:pair.slice(0,i),value:pair.slice(i+1),url:app.baseURL,secure:true,httpOnly:true,sameSite:'Lax'}]);}
  const other=await context.newPage();await other.goto(data.uri);await expect(other.getByRole('heading',{name:'登録を始めた画面へ戻ってください',exact:true})).toBeVisible();await emptyPin(other);await noStoredPin(other,data.pin);
  await expect(other.getByText('元のタブでは、LINEのカードに書かれた6桁の確認番号を入力し、「確認する」を押してください。',{exact:true})).toBeVisible();
  expect(await(await other.request.get(app.baseURL+'/api/self/line/return-status')).json()).toEqual({ok:true,state:'line_return_mismatch',csrf:null});
 }
 // Session fixtures are the only deliberate writes; return pages do not alter stores/challenges.
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toEqual({state:'line_pending',terms_version:null});expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);
 expect((await app.db.prepare('SELECT attempts FROM line_checks').first()).attempts).toBe(0);
});
test('open page expiry automatically discards prefill without navigation or a verification POST',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);
 await fixture(page,'advance',{ms:300001});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await emptyPin(page);
 expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_pending');
});
test('explicit resend invalidates old link while fresh link and manual PIN remain usable',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await fixture(page,'advance',{ms:60001});
 expect((await post(page,'line/button')).ok()).toBe(true);expect(app.pushes).toHaveLength(2);await page.goto(data.uri);await emptyPin(page);
 const action=app.pushes.at(-1).messages[0].contents.footer.contents.find(c=>c.type==='button').action;const fresh=new URL(action.uri),pin=new URLSearchParams(fresh.hash.slice(1)).get('line-confirm');
 await page.goto(fresh.href);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(pin);await page.reload();await emptyPin(page);
 await page.getByLabel('確認番号',{exact:true}).fill(pin);const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/verify'),page.getByRole('button',{name:/^(確認する|通知先を確認して次へ)$/}).click()]);expect(r.ok()).toBe(true);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');expect(app.pushes).toHaveLength(2);
});
test('logout clears pending fragment proof and old link cannot restore it',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);
 expect((await post(page,'logout')).ok()).toBe(true);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await emptyPin(page);await page.goto(data.uri);await emptyPin(page);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_pending');expect(confirmPosts()).toHaveLength(0);
});
test('method switch clears prefill and existing two-action cards still confirm through signed receipt',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await fixture(page,'advance',{ms:60001});
 app.ctx.env.SELF_LINE_ONE_BUTTON_ENABLED='false';expect((await post(page,'line/button')).ok()).toBe(true);const card=app.pushes.at(-1).messages[0],buttons=card.contents.footer.contents.filter(c=>c.type==='button');expect(buttons).toHaveLength(2);
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();await emptyPin(page);await fixture(page,'postback',{action:buttons[0].action.data,userId:'line-fixture'});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/confirm'),page.getByRole('button',{name:nextName,exact:true}).click()]);expect(r.ok()).toBe(true);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');expect(app.pushes).toHaveLength(2);
});
test('one-button sends keep minute and daily caps while explicit owner daily bypass remains effective',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);
 const blocked=await post(page,'line/button');expect(blocked.status()).toBe(429);expect((await blocked.json()).code).toBe('RATE_LIMITED');expect(app.pushes).toHaveLength(1);
 await fixture(page,'advance',{ms:60001});await app.db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,3,?)').bind('test-day:'+data.store+':'+dateKeys(app.ctx.now()).day,app.ctx.now()+86400000).run();
 expect((await post(page,'line/button')).status()).toBe(429);expect(app.pushes).toHaveLength(1);await fixture(page,'advance',{ms:60001});
 app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_ENABLED='true';app.ctx.env.SELF_LINE_CHECK_DAILY_BYPASS_OWNER_SHA256=await sha256('alice');
 expect((await post(page,'line/button')).ok()).toBe(true);expect(app.pushes).toHaveLength(2);
 const row=await app.db.prepare('SELECT used FROM rate_limits WHERE bucket=?').bind('test-day:'+data.store+':'+dateKeys(app.ctx.now()).day).first();expect(row.used).toBe(3);
});

test('fragment and history are cleared before authenticated return-status response can complete',async({page})=>{
 const data=await accepted(page);let release,seen=false;const gate=new Promise(r=>release=r);
 await page.route('**/api/self/line/return-status',async route=>{seen=true;expect(new URL(route.request().url()).hash).toBe('');await gate;await route.fallback();});
 try{await page.goto(data.uri,{waitUntil:'domcontentloaded'});await expect.poll(()=>seen).toBe(true);await noStoredPin(page,data.pin);expect(confirmPosts()).toHaveLength(0);}
 finally{release();}
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);expect(app.pushes).toHaveLength(1);
});
test('a forged six-digit link never verifies until explicit POST and still fails the existing PIN check',async({page})=>{
 const data=await accepted(page),wrong=data.pin==='000000'?'000001':'000000';await page.goto(changed(data.uri,p=>p.set('line-confirm',wrong)));
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(wrong);expect(confirmPosts()).toHaveLength(0);
 const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/verify'),page.getByRole('button',{name:nextName,exact:true}).click()]);expect(r.ok()).toBe(false);expect((await r.json()).code).toBe('PIN_INVALID');
 expect((await app.db.prepare('SELECT state,terms_version FROM stores').first())).toEqual({state:'line_pending',terms_version:null});expect((await app.db.prepare('SELECT attempts FROM line_checks').first()).attempts).toBe(1);expect(app.pushes).toHaveLength(1);
});

for(const previous of ['', '111111'])test('new hash ingress replaces prior manual PIN '+JSON.stringify(previous)+' in the same document',async({page})=>{
 const data=await accepted(page);await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await page.reload();await emptyPin(page);
 if(previous)await page.getByLabel('確認番号',{exact:true}).fill(previous);
 await page.evaluate(hash=>{location.hash=hash;},new URL(data.uri).hash);
 await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);await noStoredPin(page,data.pin);expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);
});
test('local expiry discards RAM and DOM proof even when every return-status request fails',async({page})=>{
 const data=await accepted(page);await page.clock.install({time:new Date(app.ctx.now())});await page.goto(data.uri);await expect(page.getByLabel('確認番号',{exact:true})).toHaveValue(data.pin);
 await page.route('**/api/self/line/return-status',async route=>{const r=route.request();requests.push({method:r.method(),url:r.url(),body:r.postData()});await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'REGISTRATION_CLOSED'})});});
 await page.clock.fastForward(300001);await emptyPin(page);await noStoredPin(page,data.pin);expect(confirmPosts()).toHaveLength(0);expect(app.pushes).toHaveLength(1);
});
test('original tab without the card link guides to the card, keeps PIN entry and resends the same card type',async({page})=>{
 const data=await accepted(page);
 await expect(page.getByText('次に：LINEに届いたカードの「確認して登録画面へ進む」を押してください。押せないときは、カードに書かれた6桁を下に入力して「確認する」を押してください。',{exact:true})).toBeVisible();
 await expect(page.getByText('LINEに確認番号を送りました。届いている6桁を入力してください。',{exact:true})).toHaveCount(0);
 await expect(page.getByText('アプリ切替',{exact:false})).toHaveCount(0);
 const pinOnly=page.getByRole('button',{name:'確認番号をLINEに送る',exact:true,includeHidden:true});await expect(pinOnly).toHaveCount(1);await expect(pinOnly).toBeHidden();
 await expect(page.getByRole('button',{name:'ボタン確認へ切り替えて送る',exact:true,includeHidden:true})).toHaveCount(0);
 await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();await screens(page,'onecard-detected');
 await expect(page.getByRole('button',{name:'確認カードをもう一度送る',exact:true,includeHidden:true})).toBeDisabled();
 await fixture(page,'advance',{ms:60001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 // Wait for the refreshed render (minute lock released) before opening the recovery section.
 await expect(page.getByRole('button',{name:'確認カードをもう一度送る',exact:true,includeHidden:true})).toBeEnabled();
 await page.locator('summary',{hasText:'カードが届かない・期限が切れたとき'}).click();
 const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/button'),page.getByRole('button',{name:'確認カードをもう一度送る',exact:true}).click()]);expect(r.ok()).toBe(true);
 expect(app.pushes).toHaveLength(2);expect(app.pushes[1].messages[0].contents.footer.contents.filter(c=>c.type==='button')[0].action.label).toBe('確認して登録画面へ進む');
 await page.goto(data.uri);await emptyPin(page);
 await fixture(page,'advance',{ms:300001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByText('確認カードの期限が切れたか、番号の照合回数の上限に達しました。次に：「確認カードをもう一度送る」を押してください。',{exact:true})).toBeVisible();
 const resend=page.getByRole('button',{name:'確認カードをもう一度送る',exact:true});await expect(resend).toBeVisible();await expect(resend).toBeEnabled();
 expect(await resend.evaluate(b=>b.closest('details')===null&&!b.classList.contains('secondary'))).toBe(true);
 await screens(page,'onecard-expired');expect(app.pushes).toHaveLength(2);
});
test('one-button awaiting card names the one real card button',async({page})=>{
 await accepted(page);
 // Lose the delivery record inside the 20s automatic window: status reports the automatic card as awaiting.
 await app.db.prepare('DELETE FROM line_check_deliveries').run();
 await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByText('確認カードの送信状況を確認しています。',{exact:false})).toBeVisible();
 await expect(page.getByText('確認カードの送信状況を確認しています。届いたカードの「確認して登録画面へ進む」を押してください。自動では再送しません。',{exact:true})).toBeVisible();
 await expect(page.getByText('1 このLINEで確認',{exact:false})).toHaveCount(0);
});
test('number-only resend from the original tab guides to the newest six digits and verifies by manual entry',async({page})=>{
 const data=await accepted(page);
 await fixture(page,'advance',{ms:60001});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
 await expect(page.getByRole('button',{name:'確認番号をLINEに送る',exact:true,includeHidden:true})).toBeEnabled();
 await page.locator('summary',{hasText:'カードが届かない・期限が切れたとき'}).click();
 await expect(page.getByText('「確認番号をLINEに送る」は、カードではなく番号だけを送ります。届いた6桁を下に入力して「確認する」を押してください。',{exact:true})).toBeVisible();
 const [s]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/test'),page.getByRole('button',{name:'確認番号をLINEに送る',exact:true}).click()]);expect(s.ok()).toBe(true);
 expect(app.pushes).toHaveLength(2);const sent=app.pushes[1].messages[0];expect(sent.type).toBe('text');const pin=sent.text.match(/\d{6}/)[0];expect(pin).not.toBe(data.pin);
 const guide='次に：LINEに番号だけのメッセージを送りました。いちばん新しいメッセージの6桁を下に入力し、「確認する」を押してください。前に届いたカードのボタンは使えません。';
 await expect(page.getByText(guide,{exact:true})).toBeVisible();
 await expect(page.getByText('次に：LINEに届いたカードの「確認して登録画面へ進む」を押してください。',{exact:false})).toHaveCount(0);
 // The guidance survives a reload of the original tab; the stored marker is only an expiry time.
 await page.reload();await expect(page.getByText(guide,{exact:true})).toBeVisible();await noStoredPin(page,pin);await screens(page,'onecard-pin-only');
 await page.getByLabel('確認番号',{exact:true}).fill(pin);
 const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/self/line/verify'),page.getByRole('button',{name:'確認する',exact:true}).click()]);expect(r.ok()).toBe(true);
 expect((await app.db.prepare('SELECT state FROM stores').first()).state).toBe('line_verified');expect(app.pushes).toHaveLength(2);
});
