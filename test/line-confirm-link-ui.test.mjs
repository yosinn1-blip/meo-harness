import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../worker/self-service/ui/app.js.txt',import.meta.url),'utf8').split('let state = null,')[0];
const now=Date.parse('2026-10-02T12:00:00Z'),expires=now+300000;
const fragment=`#line-confirm=123456&store=fixture-store&expires=${expires}`;
function boot(hash=fragment,search='?openExternalBrowser=1',{historyThrows=false}={}) {
 const calls=[];const location={hash,search,pathname:'/start',href:'https://self.test/start'+search+hash};
 const context={URL,URLSearchParams,Date:class extends Date{static now(){return now;}},location,document:{querySelector:()=>({})},history:{replaceState:(state,title,url)=>{calls.push({state,title,url});if(historyThrows)throw Error('history unavailable');location.href='https://self.test'+url;location.hash='';}}};
 const result=vm.runInNewContext(source+';JSON.stringify({returningFromLine,link:typeof lineConfirmLink==="undefined"?null:lineConfirmLink});',context);
 return {result:JSON.parse(result),calls,location};
}
test('valid one-button fragment is captured in RAM and removed from URL before app async boot',()=>{
 const b=boot();assert.deepEqual(b.result.link,{pin:'123456',storeId:'fixture-store',expiresAt:expires});assert.equal(b.result.returningFromLine,true);
 assert.equal(b.location.hash,'');assert.deepEqual(b.calls,[{state:null,title:'',url:'/start?openExternalBrowser=1'}]);assert.ok(!b.location.href.includes('123456'));
});
for(const [name,hash,search] of [
 ['no query',fragment,''],['PIN short','#line-confirm=12345&store=fixture-store&expires='+expires],
 ['PIN unicode','#line-confirm=１２３４５６&store=fixture-store&expires='+expires],
 ['duplicate key',fragment+'&line-confirm=000000'],['extra key',fragment+'&owner=alice'],
 ['missing store','#line-confirm=123456&expires='+expires],['store whitespace','#line-confirm=123456&store=bad%20store&expires='+expires],
 ['unsafe expiry','#line-confirm=123456&store=fixture-store&expires=999999999999999999999'],
 ['expiry malformed','#line-confirm=123456&store=fixture-store&expires=1e12'],
 ['already expired','#line-confirm=123456&store=fixture-store&expires='+now],
 ['unknown fragment','#hello=123456']
])test('fragment fail closed: '+name,()=>{const b=boot(hash,search);assert.equal(b.result.link,null);assert.equal(b.location.hash,'');assert.equal(b.result.returningFromLine,true);});
test('history removal failure discards secret rather than retaining usable prefill',()=>{const b=boot(fragment,'?openExternalBrowser=1',{historyThrows:true});assert.equal(b.result.link,null);});
test('normal start remains normal and does not rewrite history',()=>{const b=boot('','');assert.equal(b.result.link,null);assert.equal(b.result.returningFromLine,false);assert.equal(b.calls.length,0);});
