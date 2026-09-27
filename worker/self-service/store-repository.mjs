import { SelfError, ensure } from "./errors.mjs";
import { sha256 } from "./crypto.mjs";
export function mapStore(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerSub: row.owner_sub,
    accountId: row.account_id,
    locationId: row.location_id,
    title: row.title,
    state: row.state,
    generation: row.generation,
    lineUserId: row.line_user_id,
    lineVerifiedAt: row.line_verified_at,
    termsVersion: row.terms_version,
    pendingLineUserId: row.pending_line_user_id,
    updatedAt: row.updated_at,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
    metadataFetchedAt: row.metadata_fetched_at,
  };
}
export async function findOwnedStore(ctx, sub) {
  return mapStore(
    await ctx.db
      .prepare("SELECT * FROM stores WHERE owner_sub=?")
      .bind(sub)
      .first(),
  );
}
export async function getStore(ctx, id) {
  return mapStore(
    await ctx.db.prepare("SELECT * FROM stores WHERE id=?").bind(id).first(),
  );
}
export async function requireStore(ctx, actor) {
  const store = await findOwnedStore(ctx, actor.sub);
  ensure(store, "STORE_REQUIRED", 409);
  return store;
}
export function validateLocation({ accountId, locationId }) {
  ensure(
    /^accounts\/\d+$/.test(accountId) && /^locations\/\d+$/.test(locationId),
    "INVALID_LOCATION",
  );
}
export async function claimLocation(
  ctx,
  { sub, accountId, locationId, title },
) {
  validateLocation({ accountId, locationId });
  ensure(
    typeof sub === "string" && sub.length > 0 && sub.length < 256,
    "LOGIN_REQUIRED",
    401,
  );
  const existing = await findOwnedStore(ctx, sub);
  if (existing) {
    ensure(
      existing.locationId === locationId && existing.state !== "disconnected",
      "LOCATION_UNAVAILABLE",
      409,
    );
    return existing;
  }
  const id = crypto.randomUUID();
  const n = ctx.now();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO users(sub,created_at) VALUES (?,?) ON CONFLICT DO NOTHING",
        )
        .bind(sub, n),
      ctx.db
        .prepare(
          "INSERT INTO stores(id,owner_sub,account_id,location_id,title,state,created_at,updated_at,metadata_fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          sub,
          accountId,
          locationId,
          String(title).slice(0, 300),
          "location_selected",
          n,
          n,
          n,
        ),
      ctx.db
        .prepare("INSERT INTO location_claims VALUES (?,?,'self')")
        .bind(locationId, id),
    ]);
  } catch (error) {
    const again = await findOwnedStore(ctx, sub);
    if (again?.locationId === locationId && again.state !== "disconnected")
      return again;
    if (/UNIQUE|constraint/i.test(error.message))
      throw new SelfError("LOCATION_UNAVAILABLE", 409);
    throw error;
  }
  return findOwnedStore(ctx, sub);
}
export async function reserveLegacyLocations(ctx, rows) {
  for (const row of rows) {
    ensure(/^locations\/\d+$/.test(row.locationId), "INVALID_LOCATION");
    ensure(typeof row.storeId === "string" && row.storeId.length > 0, "INVALID_LOCATION");
    // KV saves and D1 reservations are not one transaction. Keep the old
    // location protected if a selection changes, fails, or races another save.
    // The separate prefix cannot collide with an original `legacy:<storeId>`.
    const claimId = `legacy-location:${await sha256(row.storeId)}:${row.locationId}`;
    try {
      await ctx.db
        .prepare("INSERT INTO location_claims VALUES (?,?,'legacy') ON CONFLICT(location_id) DO NOTHING")
        .bind(row.locationId, claimId)
        .run();
    } catch {
      throw new SelfError("LOCATION_UNAVAILABLE", 409);
    }
    const existing = await ctx.db
      .prepare("SELECT * FROM location_claims WHERE location_id=?")
      .bind(row.locationId)
      .first();
    ensure(
      existing?.mode === "legacy" &&
        (existing.store_id === claimId || existing.store_id === `legacy:${row.storeId}`),
      "LOCATION_UNAVAILABLE",
      409,
    );
  }
  return { count: rows.length };
}
