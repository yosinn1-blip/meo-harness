import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildWorker} from '../scripts/build-self-test.mjs';

test('privacy and terms are readable without login and linked from both onboarding pages',async()=>{
  const {default:worker}=await import(await buildWorker());
  for(const [path,title] of [['/self/privacy','プライバシー'],['/self/terms','利用条件']]){
    const res=await worker.fetch(new Request('https://meo.test'+path),{},{});
    assert.equal(res.status,200,path);
    assert.match(res.headers.get('Content-Type'),/text\/html/);
    assert.equal(res.headers.get('Cache-Control'),'no-store');
    assert.match(res.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
    const body=await res.text();assert.ok(body.includes(title));assert.match(body,/mailto:meo.harness@gmail.com/);
    assert.equal((await worker.fetch(new Request('https://meo.test'+path,{method:'POST'}),{},{})).status,405);
  }
  for(const path of ['/start','/account']){
    const body=await (await worker.fetch(new Request('https://meo.test'+path),{},{})).text();
    assert.match(body,/href="\/self\/privacy"/);assert.match(body,/href="\/self\/terms"/);
  }
});

test('terms name the trademarks and policies say what is checked instead of "identity"',async()=>{
  const {default:worker}=await import(await buildWorker());
  const terms=await (await worker.fetch(new Request('https://meo.test/self/terms'),{},{})).text();
  assert.ok(terms.includes('Google LLC の商標'));
  assert.ok(terms.includes('LINEヤフー株式会社'));
  assert.equal(terms.split('本人確認').length-1,0);
  const privacy=await (await worker.fetch(new Request('https://meo.test/self/privacy'),{},{})).text();
  assert.equal(privacy.split('本人確認').length-1,1);
  assert.ok(privacy.includes('本人確認が必要な場合があります。'));
});
