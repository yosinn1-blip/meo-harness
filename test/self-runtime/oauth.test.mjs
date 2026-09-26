import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withD1,
  applySchema,
  fixtureEnv,
  seedStore,
} from "../support/self-runtime.mjs";
import {
  googleFixture,
  seedGoogleCredential,
} from "../support/self-google.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import {
  createSession,
  readSession,
} from "../../worker/self-service/session.mjs";
import { startGoogle, finishGoogle } from "../../worker/self-service/oauth.mjs";
function startRequest(s) {
  return new Request("https://meo.test/api/self/google/start", {
    method: "POST",
    headers: {
      Origin: "https://meo.test",
      Cookie: s.cookie.split(";")[0],
      "X-CSRF-Token": s.csrf,
    },
  });
}
function callback(url, code, s) {
  const u = new URL("https://meo.test/api/self/google/callback");
  u.searchParams.set("state", new URL(url).searchParams.get("state"));
  u.searchParams.set("code", code);
  return new Request(u, { headers: { Cookie: s.cookie.split(";")[0] } });
}
test("state is browser-bound single-use; callback rotates session and stores encrypted refresh", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const f = await googleFixture();
  const ctx = createSelfContext(fixtureEnv(db), { fetchImpl: f.fetchImpl });
  const s = await createSession(ctx, null),
    other = await createSession(ctx, null);
  const { authorizationUrl: url } = await startGoogle(ctx, startRequest(s), {
    intent: "connect",
    challenge: "x",
  });
  const code = await f.authorize(url);
  assert.equal(new URL(url).searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(
    () => finishGoogle(ctx, callback(url, code, other)),
    (e) => e.code === "OAUTH_STATE_INVALID",
  );
  const response = await finishGoogle(ctx, callback(url, code, s));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/account");
  assert.equal(await readSession(ctx, startRequest(s)), null);
  const saved = await db
    .prepare("SELECT ciphertext FROM google_credentials")
    .first();
  assert.ok(!saved.ciphertext.includes("fixture-refresh"));
  await assert.rejects(
    () => finishGoogle(ctx, callback(url, code, s)),
    (e) => e.code === "OAUTH_STATE_INVALID",
  );
});
test("openid-only login works with registration disabled and never changes credentials", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const f = await googleFixture();
  const ctx = createSelfContext(
    fixtureEnv(db, { SELF_REGISTRATION_ENABLED: "false" }),
    { fetchImpl: f.fetchImpl },
  );
  await seedGoogleCredential(ctx);
  const before = await db
    .prepare("SELECT ciphertext FROM google_credentials")
    .first();
  const s = await createSession(ctx, null);
  const { authorizationUrl: url } = await startGoogle(ctx, startRequest(s), {
    intent: "login",
    challenge: "x",
  });
  assert.equal(new URL(url).searchParams.get("scope"), "openid");
  await finishGoogle(ctx, callback(url, await f.authorize(url), s));
  assert.deepEqual(
    await db.prepare("SELECT ciphertext FROM google_credentials").first(),
    before,
  );
});
test("reconnect cannot substitute another Google sub; expiry and denial never grant credentials", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  let n = Date.now();
  const f = await googleFixture({ sub: "bob", now: () => n });
  const ctx = createSelfContext(fixtureEnv(db), {
    now: () => n,
    fetchImpl: f.fetchImpl,
  });
  await seedStore(ctx);
  const s = await createSession(ctx, "alice");
  const { authorizationUrl: url } = await startGoogle(ctx, startRequest(s), {
    intent: "reconnect",
    challenge: "x",
  });
  const code = await f.authorize(url);
  await assert.rejects(
    () => finishGoogle(ctx, callback(url, code, s)),
    (e) => e.code === "GOOGLE_ACCOUNT_MISMATCH",
  );
  const next = await startGoogle(ctx, startRequest(s), {
    intent: "reconnect",
    challenge: "x",
  });
  const c = await f.authorize(next.authorizationUrl);
  n += 600000;
  await assert.rejects(
    () => finishGoogle(ctx, callback(next.authorizationUrl, c, s)),
    (e) => e.code === "OAUTH_STATE_INVALID",
  );
  assert.equal(
    await db.prepare("SELECT * FROM google_credentials").first(),
    null,
  );
});
test("callback after disconnect cannot restore credentials or a session", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const f = await googleFixture();
  const ctx = createSelfContext(fixtureEnv(db), { fetchImpl: f.fetchImpl });
  await seedStore(ctx);
  await seedGoogleCredential(ctx);
  const s = await createSession(ctx, "alice");
  const { authorizationUrl: url } = await startGoogle(ctx, startRequest(s), {
    intent: "reconnect",
    challenge: "x",
  });
  const code = await f.authorize(url);
  const { disconnectStore } = await import(
    "../../worker/self-service/lifecycle.mjs"
  );
  await disconnectStore(ctx, { sub: "alice" });
  await assert.rejects(() => finishGoogle(ctx, callback(url, code, s)));
  assert.equal(
    await db.prepare("SELECT * FROM google_credentials").first(),
    null,
  );
  assert.equal(await db.prepare("SELECT * FROM sessions").first(), null);
});
