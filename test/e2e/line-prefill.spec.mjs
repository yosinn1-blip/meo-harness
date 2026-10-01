import {test,expect} from '@playwright/test';
import {startTestApp} from '../support/self-browser.mjs';
let app, unexpected;
test.beforeEach(async({context})=>{
  app=await startTestApp();unexpected=[];
  await context.setExtraHTTPHeaders({'X-Fixture-Key':app.fixtureKey});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='challenges.cloudflare.com' && url.pathname==='/turnstile/v0/api.js')
      return route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,o)=>{o.callback("fixture-challenge");return "fixture-widget";}};'});
    if(url.origin===app.baseURL)return route.continue();
    unexpected.push(url.origin);return route.abort('blockedbyclient');
  });
  await context.request.post(app.baseURL+'/fixture/scenario',{
    data:{lineFriendUrl:'https://line.me/R/ti/p/@fixture'},headers:{'X-Fixture-Key':app.fixtureKey},
  });
});
test.afterEach(async({context})=>{
  try {expect(unexpected).toEqual([]);expect(app.unexpected).toEqual([]);}
  finally {await context.close();await app.stop();}
});
function fixture(page,path,data={}){
  return page.request.post(app.baseURL+'/fixture/'+path,{data,headers:{'X-Fixture-Key':app.fixtureKey}});
}
async function prepare(page){
  await page.setViewportSize({width:375,height:812});
  await page.goto(app.baseURL+'/start');
  await page.getByRole('button',{name:'初めての方：Googleでお店を接続',exact:true}).click();
  await page.getByRole('button',{name:'架空Googleで許可',exact:true}).click();
  await page.getByRole('button',{name:'この店舗を使う',exact:true}).click();
  return page.getByTestId('line-code').textContent();
}
const prefill=page=>page.getByRole('link',{name:'LINEを開く（コード入力済み）',exact:true});

for(const automatic of [false,true])test(`prefilled LINE chat keeps the original browser and needs a human send (${automatic?'ON':'OFF'})`,async({page,context})=>{
  let activates=0;page.on('request',r=>{if(r.url().endsWith('/api/self/activate'))activates++;});
  await fixture(page,'scenario',{autoPin:automatic});
  const code=await prepare(page);
  const url=new URL(await prefill(page).getAttribute('href'));
  expect(url.origin).toBe('https://line.me');
  expect(url.pathname).toBe('/R/oaMessage/%40fixture/');
  expect(decodeURIComponent(url.search.slice(1))).toBe(code);
  await expect(prefill(page)).toHaveAttribute('rel','noopener noreferrer');
  await expect(prefill(page)).toHaveAttribute('referrerpolicy','no-referrer');
  expect(new URL(page.url()).search).toBe('');
  let opened=0;
  // The first popup request is intercepted at context level. No real LINE opens.
  await context.route('https://line.me/R/oaMessage/**',async route=>{
    opened++;expect(route.request().headers()['referer']).toBeUndefined();
    expect(route.request().url()).toBe(url.href);
    await route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><h1>架空LINEトーク</h1><p>送信は本人の操作です。</p>'});
  });
  for(const [width,name] of [[320,'mobile320'],[375,'mobile375'],[1280,'desktop']]){
    await page.setViewportSize({width,height:812});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`output/self-service/prefill-${automatic?'on':'off'}-${name}.png`,fullPage:true});
  }
  const originalURL=page.url();
  const popupPromise=page.waitForEvent('popup');await prefill(page).click();
  const popup=await popupPromise;await popup.waitForLoadState();
  await expect(popup.getByRole('heading',{name:'架空LINEトーク'})).toBeVisible();
  expect(page.url()).toBe(originalURL);expect(opened).toBe(1);expect(app.pushes).toHaveLength(0);
  await popup.close();
  await fixture(page,'line',{code,userId:'line-prefill-fixture'});
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('LINEを検出しました。6桁の番号で通知先を確認します。',{exact:true})).toBeVisible();
  await expect(prefill(page)).toHaveCount(0);
  if(!automatic){
    expect(app.pushes).toHaveLength(0);
    await page.getByRole('button',{name:'確認番号をLINEに送る',exact:true}).click();
    await expect(page.getByRole('link',{name:'LINEで確認番号を見る',exact:true})).toHaveAttribute('href','https://line.me/R/oaMessage/%40fixture');
  }
  await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();
  expect(app.pushes).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel('確認番号',{exact:true})).toBeVisible();
  expect(app.pushes).toHaveLength(1);
  const pin=(await(await fixture(page,'pin')).json()).pin;
  await page.getByLabel('確認番号',{exact:true}).fill(pin);
  await page.getByRole('button',{name:'確認する',exact:true}).click();
  await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
  await expect(page.getByLabel('利用条件を確認しました')).not.toBeChecked();
  await page.getByRole('button',{name:'利用を開始する',exact:true}).click();
  await expect(page.getByRole('heading',{name:'準備ができました',exact:true})).toBeVisible();
  expect(activates).toBe(0);
  expect(app.writes).toEqual([]);
});

test('expired prefill clicks never open LINE or copy the old code',async({page,context})=>{
  await prepare(page);
  await expect(prefill(page)).toBeVisible();
  let outgoing=0;
  await context.route('https://line.me/**',route=>{outgoing++;return route.abort();});
  await page.evaluate(()=>{const previous=Date.now;Date.now=()=>previous()+16*60*1000;});
  await prefill(page).click();
  await expect(prefill(page)).toHaveCount(0);
  await expect(page.getByTestId('line-code')).toHaveCount(0);
  await expect(page.getByText('登録コードの期限が切れました。再発行してからLINEへ送ってください。',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'コードを再発行',exact:true})).toBeVisible();
  expect(outgoing).toBe(0);expect(app.pushes).toEqual([]);
});

test('interruption needs explicit code reissue and includes first-friend, PC and uninstalled fallback',async({page})=>{
  let issued=0;page.on('request',r=>{if(r.url().endsWith('/api/self/line/code'))issued++;});
  const code=await prepare(page);
  await page.getByText('LINEが開かない・友だち追加・PCから登録する方',{exact:true}).click();
  await expect(page.getByRole('button',{name:'登録コードをコピー',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'LINEで友だち追加',exact:true})).toHaveAttribute('href','https://line.me/R/ti/p/@fixture');
  await expect(page.getByText(/友だち追加.*もう一度/)).toBeVisible();
  await expect(page.getByText(/インストール/)).toBeVisible();
  await expect(page.locator('img.qr')).toHaveAttribute('src','/self/assets/line-qr.svg');
  expect((await page.locator('img.qr').getAttribute('src')).includes(code)).toBe(false);
  expect(issued).toBe(1);await page.reload();
  await expect(page.getByRole('button',{name:'LINEの登録コードを表示',exact:true})).toBeVisible();
  expect(issued).toBe(1);expect(app.pushes).toEqual([]);
  await page.getByRole('button',{name:'LINEの登録コードを表示',exact:true}).click();
  await expect(prefill(page)).toBeVisible();expect(issued).toBe(2);
  expect(await page.getByTestId('line-code').textContent()).not.toBe(code);
});

test('prefill never attaches a code to an unrecognised or redirected friend URL',async({page})=>{
  await fixture(page,'scenario',{lineFriendUrl:'https://attacker.invalid/R/ti/p/@fixture'});
  await prepare(page);
  for(const value of ['https://attacker.invalid/R/ti/p/@fixture','https://line.me/R/ti/p/@fixture?redirect=elsewhere','https://line.me/R/ti/p/%40fixture%2Fother']){
    await fixture(page,'scenario',{lineFriendUrl:value});await page.getByRole('button',{name:'状態を更新',exact:true}).click();
    await expect(prefill(page)).toHaveCount(0);
    expect(await page.locator('a[href*="oaMessage"]').count()).toBe(0);
    await expect(page.getByRole('button',{name:'登録コードをコピー',exact:true})).toBeVisible();
  }
  expect(app.pushes).toEqual([]);
});

test('returning to the same tab keeps a partially entered PIN and only reads status',async({page})=>{
  const code=await prepare(page);
  await fixture(page,'line',{code,userId:'line-prefill-fixture'});
  await page.getByRole('button',{name:'LINEの検出状態を更新',exact:true}).click();
  await page.getByRole('button',{name:'確認番号をLINEに送る',exact:true}).click();
  await expect(page.getByText('LINEに確認番号を送りました。届いている6桁を入力してください。',{exact:true})).toBeVisible();
  const input=page.getByLabel('確認番号',{exact:true});
  await input.fill('12');
  let reads=0,writes=0;
  page.on('request',r=>{
    if(r.url().includes('/api/self/')){
      if(r.method()==='GET'&&r.url().endsWith('/status'))reads++;
      if(r.method()!=='GET')writes++;
    }
  });
  const finished=page.waitForEvent('requestfinished',r=>r.url().endsWith('/api/self/status'));
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await finished;
  await expect.poll(()=>reads).toBeGreaterThan(0);
  await expect(input).toHaveValue('12');
  expect(writes).toBe(0);expect(app.pushes).toHaveLength(1);
});
