import { test } from "node:test";
import assert from "node:assert/strict";
import { withD1, applySchema } from "../support/self-runtime.mjs";
import { createSelfContext } from "../../worker/self-service/config.mjs";
import {
  claimLocation,
  findOwnedStore,
  reserveLegacyLocations,
} from "../../worker/self-service/store-repository.mjs";
const location = {
  accountId: "accounts/1",
  locationId: "locations/2",
  title: "架空店",
};
test("concurrent owners cannot claim the same location; loser transaction rolls back", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext({ SELF_DB: db });
  const out = await Promise.allSettled(
    ["alice", "bob"].map((sub) => claimLocation(ctx, { sub, ...location })),
  );
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM users").first()).n, 1);
  const winner = out.find((x) => x.status === "fulfilled").value;
  assert.equal(
    (await claimLocation(ctx, { sub: winner.ownerSub, ...location })).id,
    winner.id,
  );
  await assert.rejects(
    () =>
      claimLocation(ctx, {
        sub: winner.ownerSub,
        ...location,
        locationId: "locations/3",
      }),
    (e) => e.code === "LOCATION_UNAVAILABLE",
  );
});
test("legacy reservations are paged, idempotent and conflict with self ownership", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext({ SELF_DB: db });
  await reserveLegacyLocations(ctx, [
    { storeId: "legacy", locationId: "locations/2" },
  ]);
  await reserveLegacyLocations(ctx, [
    { storeId: "legacy", locationId: "locations/2" },
  ]);
  await assert.rejects(
    () => claimLocation(ctx, { sub: "alice", ...location }),
    (e) => e.code === "LOCATION_UNAVAILABLE",
  );
  assert.equal(await findOwnedStore(ctx, "alice"), null);
  await reserveLegacyLocations(ctx, [
    { storeId: "second", locationId: "locations/3" },
  ]);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM location_claims").first()).n,
    2,
  );
});
test("invalid canonical ids cannot become claims", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext({ SELF_DB: db });
  await assert.rejects(
    () =>
      claimLocation(ctx, { sub: "a", ...location, locationId: "../../other" }),
    (e) => e.code === "INVALID_LOCATION",
  );
});

test("legacy location changes retain old reservations and reserve new locations without replacing self ownership", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext({ SELF_DB: db });
  // Production preparation used the original, store-scoped reservation key.
  await db.prepare("INSERT INTO location_claims VALUES (?,?,'legacy')")
    .bind('locations/2', 'legacy:existing').run();
  await reserveLegacyLocations(ctx, [{ storeId: 'existing', locationId: 'locations/3' }]);
  // Re-selection and a retry after a failed KV save must remain idempotent.
  await reserveLegacyLocations(ctx, [{ storeId: 'existing', locationId: 'locations/3' }]);
  await reserveLegacyLocations(ctx, [{ storeId: 'existing', locationId: 'locations/2' }]);
  assert.equal((await db.prepare('SELECT count(*) n FROM location_claims').first()).n, 2);
  for (const locationId of ['locations/2', 'locations/3']) {
    await assert.rejects(() => claimLocation(ctx, { sub: 'new-owner', ...location, locationId }), e => e.code === 'LOCATION_UNAVAILABLE');
    await assert.rejects(() => reserveLegacyLocations(ctx, [{ storeId: 'other-legacy', locationId }]), e => e.code === 'LOCATION_UNAVAILABLE');
  }
  await claimLocation(ctx, { sub: 'self-owner', ...location, locationId: 'locations/4' });
  await assert.rejects(() => reserveLegacyLocations(ctx, [{ storeId: 'existing', locationId: 'locations/4' }]), e => e.code === 'LOCATION_UNAVAILABLE');
  assert.equal((await findOwnedStore(ctx, 'self-owner')).locationId, 'locations/4');
});

test("legacy reservations are retry-safe when concurrent requests select the same location", async (t) => {
  const { db } = await withD1(t);
  await applySchema(db);
  const ctx = createSelfContext({ SELF_DB: db });
  const rows = [{ storeId: 'same-legacy', locationId: 'locations/8' }];
  await Promise.all([reserveLegacyLocations(ctx, rows), reserveLegacyLocations(ctx, rows)]);
  assert.equal((await db.prepare('SELECT count(*) n FROM location_claims').first()).n, 1);
  const results = await Promise.allSettled(['one', 'two'].map(storeId => reserveLegacyLocations(ctx, [{ storeId, locationId: 'locations/9' }])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'LOCATION_UNAVAILABLE').length, 1);
});
