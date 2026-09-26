import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { evaluateReleaseGate } from "../scripts/check-self-release.mjs";
test("local E2E does not approve public launch", () => {
  const r = evaluateReleaseGate({ localTests: true, browserStubE2E: true });
  assert.equal(r.ready, false);
  assert.ok(r.blocking.includes("OAUTH_VERIFICATION"));
  assert.ok(r.blocking.includes("LIVE_CONNECTION"));
});
test("all gates need strict positive evidence", () => {
  const names = [
    "oauthVerified",
    "quotaChecked",
    "localTests",
    "browserStubE2E",
    "liveConnection",
    "liveStopVerified",
    "privacyReviewed",
    "approvedRelease",
  ];
  const complete = Object.fromEntries(names.map((n) => [n, true]));
  assert.equal(evaluateReleaseGate(complete).ready, true);
  for (const name of names)
    for (const value of [undefined, false, "true", 1])
      assert.equal(
        evaluateReleaseGate({ ...complete, [name]: value }).ready,
        false,
      );
});
test("missing evidence file is a blocked CLI exit, not a deploy", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/check-self-release.mjs", "--evidence", "output/no-evidence.json"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ready, false);
});
