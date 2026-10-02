import { test } from "node:test";
import assert from "node:assert/strict";
import { readSelfConfig } from "../worker/self-service/config.mjs";
import { fixtureEnv } from "./support/self-runtime.mjs";
test("missing settings close registration and never mean unlimited", () => {
  const c = readSelfConfig({ SELF_REGISTRATION_ENABLED: "true" });
  assert.equal(c.registrationEnabled, false);
  assert.equal(c.configured, false);
  assert.equal(c.limits.maxActiveStores, 0);
});
test("invalid caps or origin fail closed; valid explicit settings open", () => {
  const env = fixtureEnv({});
  assert.equal(readSelfConfig(env).registrationEnabled, true);
  for (const v of ["", "-1", "NaN", "1.5", "9007199254740992"])
    assert.equal(
      readSelfConfig({ ...env, SELF_MAX_ACTIVE_STORES: v }).registrationEnabled,
      false,
    );
  for (const v of ["https://meo.test/path", "http://meo.test", "bad"])
    assert.equal(
      readSelfConfig({ ...env, SELF_PUBLIC_ORIGIN: v }).configured,
      false,
    );
});
test("registration closure does not disable authenticated processing", () => {
  const c = readSelfConfig(
    fixtureEnv({}, { SELF_REGISTRATION_ENABLED: "false" }),
  );
  assert.equal(c.registrationEnabled, false);
  assert.equal(c.processingEnabled, true);
});
test("LINE button is default OFF, strict manual-only opt-in, and closed in pilot/processing OFF", () => {
  for(const value of [undefined,"false","","TRUE",true])
    assert.equal(readSelfConfig(fixtureEnv({}, {SELF_LINE_BUTTON_CONFIRM_ENABLED:value})).lineButtonConfirm,false);
  const enabled=fixtureEnv({}, {SELF_LINE_BUTTON_CONFIRM_ENABLED:"true"});
  assert.equal(readSelfConfig(enabled).lineButtonConfirm,true);
  for(const override of [{SELF_LINE_AUTO_PIN_ENABLED:"true"},{SELF_PROCESSING_ENABLED:"false"},{SELF_PILOT_OWNER_SHA256:""}])
    assert.equal(readSelfConfig({...enabled,...override}).lineButtonConfirm,false);
  assert.equal(readSelfConfig({...enabled,SELF_LINE_AUTO_PIN_ENABLED:"true"}).autoLinePin,true);
});
