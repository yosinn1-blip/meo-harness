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
