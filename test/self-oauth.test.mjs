import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./support/self-google.mjs";
import { verifyGoogleIdToken } from "../worker/self-service/oauth.mjs";
test("valid signatures still require nonce, audience, issuer, expiry and azp", async () => {
  const f = await googleFixture();
  const opts = {
    jwks: f.jwks,
    clientId: "fixture-client",
    nonce: "expected",
    now: Date.now,
  };
  assert.equal(
    (await verifyGoogleIdToken(await f.token("expected"), opts)).sub,
    "alice",
  );
  for (const [nonce, extra, opt] of [
    ["wrong", {}, {}],
    ["expected", { azp: "attacker" }, {}],
    ["expected", {}, { clientId: "other" }],
    ["expected", {}, { now: () => Date.now() + 600000 }],
  ]) {
    const token = await f.token(nonce, extra);
    await assert.rejects(
      () => verifyGoogleIdToken(token, { ...opts, ...opt }),
      (e) => e.code === "GOOGLE_IDENTITY_INVALID",
    );
  }
  const second = await googleFixture();
  const bad = await second.token("expected");
  await assert.rejects(
    () => verifyGoogleIdToken(bad, opts),
    (e) => e.code === "GOOGLE_IDENTITY_INVALID",
  );
});
