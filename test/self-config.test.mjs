import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSelfConfig} from '../worker/self-service/config.mjs';
import {fixtureEnv} from './support/self-runtime.mjs';
test('missing settings close registration and never mean unlimited',()=>{
 const c=readSelfConfig({SELF_REGISTRATION_ENABLED:'true'});
 assert.equal(c.registrationEnabled,false);assert.equal(c.configured,false);assert.equal(c.limits.maxActiveStores,0);
});
test('invalid caps or origin fail closed; valid explicit settings open',()=>{
 const env=fixtureEnv({}); assert.equal(readSelfConfig(env).registrationEnabled,true);
 for(const v of ['', '-1','NaN','1.5','9007199254740992']) assert.equal(readSelfConfig({...env,SELF_MAX_ACTIVE_STORES:v}).registrationEnabled,false);
 for(const v of ['https://meo.test/path','http://meo.test','bad'])assert.equal(readSelfConfig({...env,SELF_PUBLIC_ORIGIN:v}).configured,false);
});
test('registration closure does not disable authenticated processing',()=>{
 const c=readSelfConfig(fixtureEnv({}, {SELF_REGISTRATION_ENABLED:'false'}));
 assert.equal(c.registrationEnabled,false);assert.equal(c.processingEnabled,true);
});
