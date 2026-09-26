import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, unseal } from "../worker/self-service/crypto.mjs";
import { readBody, verifyChallenge } from "../worker/self-service/abuse.mjs";
import { createSelfContext } from "../worker/self-service/config.mjs";
test("AES ciphertext is bound to owner and cannot be tampered", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const box = await seal("secret", key, "google:a");
  assert.equal(await unseal(box, key, "google:a"), "secret");
  await assert.rejects(() => unseal(box, key, "google:b"));
  await assert.rejects(() =>
    unseal(box.slice(0, -6) + "aaaaaa", key, "google:a"),
  );
});
test("chunked bodies do not bypass size limits; malformed JSON is rejected", async () => {
  const req = new Request("https://meo.test", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(17000));
        c.close();
      },
    }),
    duplex: "half",
  });
  await assert.rejects(
    () => readBody(req),
    (e) => e.code === "BODY_TOO_LARGE",
  );
  await assert.rejects(
    () =>
      readBody(new Request("https://meo.test", { method: "POST", body: "{" })),
    (e) => e.code === "INVALID_JSON",
  );
});
test("Turnstile validates hostname/action and fails closed without secret", async () => {
  for (const data of [
    { success: false },
    { success: true, hostname: "evil.test", action: "self_start" },
    { success: true, hostname: "meo.test", action: "other" },
  ]) {
    const c = createSelfContext(
      {
        TURNSTILE_SECRET_KEY: "fixture",
        SELF_PUBLIC_ORIGIN: "https://meo.test",
      },
      { fetchImpl: async () => Response.json(data) },
    );
    await assert.rejects(
      () =>
        verifyChallenge(c, {
          token: "fixture",
          ip: "127.0.0.1",
          action: "self_start",
        }),
      (e) => e.code === "CHALLENGE_FAILED",
    );
  }
  await assert.rejects(
    () => verifyChallenge(createSelfContext({}), { token: "x" }),
    (e) => e.code === "REGISTRATION_CLOSED",
  );
});
