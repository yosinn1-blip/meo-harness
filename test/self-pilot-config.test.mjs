import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../worker/self-service/config.mjs';
import { fixtureEnv } from './support/self-runtime.mjs';
import { pilotSettings } from './support/self-pilot.mjs';

test('pilot permits only authenticated owner with explicit one-store zero-send settings', async () => {
  const env = fixtureEnv({}, await pilotSettings());
  const c = config.readSelfConfig(env);
  assert.equal(c.pilotMode, true);
  assert.equal(c.registrationEnabled, false);
  assert.equal(c.processingEnabled, false);
  const ctx = config.createSelfContext(env);
  assert.equal(await config.canRegisterSelf(ctx, 'alice'), true);
  for (const sub of [null, undefined, '', 'bob', env.SELF_PILOT_OWNER_SHA256])
    assert.equal(await config.canRegisterSelf(ctx, sub), false);
});
test('malformed pilot setting and accidental public/processing enablement fail closed', async () => {
  const env = fixtureEnv({}, await pilotSettings());
  for (const overrides of [
    {SELF_PILOT_OWNER_SHA256: ''}, {SELF_PILOT_OWNER_SHA256: 'broken'},
    {SELF_REGISTRATION_ENABLED: 'true'}, {SELF_PROCESSING_ENABLED: 'true'},
    {SELF_MAX_ACTIVE_STORES: '2'}, {SELF_MAX_ACTIVE_STORES: '0'},
    {SELF_MONTHLY_DRAFT_LIMIT: '1'}, {SELF_MONTHLY_PUSH_LIMIT: '1'},
    {SELF_MONTHLY_DRAFT_LIMIT: 'NaN'}, {SELF_MONTHLY_PUSH_LIMIT: undefined},
    {TURNSTILE_SECRET_KEY: undefined}, {SELF_TERMS_VERSION: undefined},
  ]) {
    const ctx = config.createSelfContext({...env, ...overrides});
    const c = config.readSelfConfig(ctx.env);
    assert.equal(c.pilotMode, true);
    assert.equal(c.registrationEnabled, false);
    assert.equal(c.processingEnabled, false);
    assert.equal(await config.canRegisterSelf(ctx, 'alice'), false);
  }
});
