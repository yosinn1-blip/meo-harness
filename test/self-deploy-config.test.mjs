import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSelfConfig } from "../worker/self-service/config.mjs";
import { fixtureEnv } from "./support/self-runtime.mjs";

// A plain `wrangler deploy` overwrites production vars with these values,
// so the committed [vars] must equal the production LINE flow.
function tomlVars() {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const section = toml.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0];
  assert.ok(section, "[vars] section exists");
  const vars = {};
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

test("wrangler.toml [vars] match the production LINE one-button flow", () => {
  const vars = tomlVars();
  for (const key of [
    "SELF_REGISTRATION_ENABLED",
    "SELF_PROCESSING_ENABLED",
    "SELF_LINE_BUTTON_CONFIRM_ENABLED",
    "SELF_LINE_AUTO_BUTTON_ENABLED",
    "SELF_LINE_ONE_BUTTON_ENABLED",
  ])
    assert.equal(vars[key], "true", key);
  assert.equal(vars.SELF_LINE_AUTO_PIN_ENABLED, "false");
});

test("wrangler.toml never pins owner-only or secret settings", () => {
  for (const key of Object.keys(tomlVars())) {
    assert.ok(!key.includes("SHA256"), key);
    assert.ok(!key.includes("DAILY_BYPASS"), key);
  }
});

test("the committed vars produce the production status flags", () => {
  const c = readSelfConfig(fixtureEnv({}, tomlVars()));
  assert.equal(c.lineButtonConfirm, true);
  assert.equal(c.autoLineButton, true);
  assert.equal(c.lineOneButton, true);
  assert.equal(c.autoLinePin, false);
});

test("npm run deploy keeps dashboard-only vars", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.deploy, /--keep-vars/);
});
