import { googleAccessToken, googleJson } from "./google.mjs";
import { listGbpAccountsPage, listGbpLocationsPage } from "../../src/gbp.mjs";
import { ensure, SelfError } from "./errors.mjs";
import { randomToken, sha256, seal, unseal, tokenKey } from "./crypto.mjs";
import { claimLocation, validateLocation, findOwnedStore } from "./store-repository.mjs";
import { readSelfConfig, canRegisterSelf } from "./config.mjs";
export async function discoverLocations(ctx, actor, { cursor = null } = {}) {
  if (readSelfConfig(ctx.env).pilotMode)
    ensure(await canRegisterSelf(ctx, actor.sub), "REGISTRATION_CLOSED", 503);
  let progress = {
    accounts: [],
    index: 0,
    accountToken: null,
    locationToken: null,
    started: false,
  };
  if (cursor) {
    ensure(typeof cursor === "string" && cursor.length < 200, "CURSOR_INVALID");
    const row = await ctx.db
      .prepare(
        "SELECT * FROM location_cursors WHERE token_hash=? AND owner_sub=? AND expires_at>?",
      )
      .bind(await sha256(cursor), actor.sub, ctx.now())
      .first();
    ensure(row, "CURSOR_INVALID");
    progress = JSON.parse(
      await unseal(
        row.payload_ciphertext,
        tokenKey(ctx),
        "cursor:" + actor.sub,
      ),
    );
  }
  const accessToken = await googleAccessToken(ctx, actor.sub);
  const locations = [];
  let partial = false,
    done = false;
  for (let i = 0; i < 2; i++) {
    if (progress.index >= progress.accounts.length) {
      if (progress.started && !progress.accountToken) {
        done = true;
        break;
      }
      let page;
      try {
        page = await listGbpAccountsPage({
          accessToken,
          pageToken: progress.accountToken,
          fetchImpl: ctx.fetchImpl,
        });
      } catch {
        throw new SelfError("GOOGLE_UNAVAILABLE", 502);
      }
      progress.accounts = page.items;
      progress.index = 0;
      progress.accountToken = page.nextPageToken;
      progress.started = true;
      if (!progress.accounts.length) {
        done = !progress.accountToken;
        break;
      }
    }
    const accountId = progress.accounts[progress.index].name;
    ensure(/^accounts\/\d+$/.test(accountId), "GOOGLE_UNAVAILABLE", 502);
    let page;
    try {
      page = await listGbpLocationsPage({
        accessToken,
        accountId,
        pageToken: progress.locationToken,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (error) {
      if (error.status === 403) {
        partial = true;
        progress.index++;
        progress.locationToken = null;
        continue;
      }
      throw new SelfError("GOOGLE_UNAVAILABLE", 502);
    }
    for (const loc of page.items) {
      validateLocation({ accountId, locationId: loc.name });
      locations.push({
        accountId,
        locationId: loc.name,
        title: String(loc.title ?? "").slice(0, 300),
      });
    }
    progress.locationToken = page.nextPageToken;
    if (!page.nextPageToken) progress.index++;
  }
  if (locations.length)
    await ctx.db.batch(
      locations.map((loc) =>
        ctx.db
          .prepare(
            "INSERT OR REPLACE INTO location_candidates VALUES (?,?,?,?,?)",
          )
          .bind(
            actor.sub,
            loc.accountId,
            loc.locationId,
            loc.title,
            ctx.now() + 600000,
          ),
      ),
    );
  done =
    done ||
    (progress.started &&
      !progress.accountToken &&
      progress.index >= progress.accounts.length);
  let nextCursor = null;
  if (!done) {
    nextCursor = randomToken();
    await ctx.db
      .prepare("INSERT INTO location_cursors VALUES (?,?,?,?)")
      .bind(
        await sha256(nextCursor),
        actor.sub,
        await seal(
          JSON.stringify(progress),
          tokenKey(ctx),
          "cursor:" + actor.sub,
        ),
        ctx.now() + 600000,
      )
      .run();
  }
  return { locations, nextCursor, partial };
}
export async function verifyLocationAccess(
  ctx,
  actor,
  { accountId, locationId },
  { refreshAccount = false } = {},
) {
  validateLocation({ accountId, locationId });
  const token = await googleAccessToken(ctx, actor.sub);
  if(refreshAccount){
    const account=await googleJson(ctx,`https://mybusinessaccountmanagement.googleapis.com/v1/${accountId}`,{headers:{Authorization:'Bearer '+token}});
    ensure(account.name===accountId,'LOCATION_NOT_ACCESSIBLE',403);
  }
  const data = await googleJson(
    ctx,
    `https://mybusinessbusinessinformation.googleapis.com/v1/${locationId}?readMask=name,title`,
    { headers: { Authorization: "Bearer " + token } },
  );
  ensure(data.name === locationId, "LOCATION_NOT_ACCESSIBLE", 403);
  ensure(typeof data.title==='string', "LOCATION_NOT_ACCESSIBLE", 403);
  return data;
}
export async function selectLocation(ctx, actor, ids) {
  ensure(
    await canRegisterSelf(ctx, actor.sub),
    "REGISTRATION_CLOSED",
    503,
  );
  if (readSelfConfig(ctx.env).pilotMode && !(await findOwnedStore(ctx, actor.sub))) {
    const count = await ctx.db.prepare("SELECT count(*) n FROM location_claims WHERE mode='self'").first();
    ensure(count.n < 1, "CAPACITY_UNAVAILABLE", 409);
  }
  validateLocation(ids);
  const candidate = await ctx.db
    .prepare(
      "SELECT title FROM location_candidates WHERE owner_sub=? AND account_id=? AND location_id=? AND expires_at>?",
    )
    .bind(actor.sub, ids.accountId, ids.locationId, ctx.now())
    .first();
  ensure(candidate, "LOCATION_NOT_ACCESSIBLE", 403);
  const actual = await verifyLocationAccess(ctx, actor, ids);
  return claimLocation(ctx, {
    sub: actor.sub,
    accountId: ids.accountId,
    locationId: ids.locationId,
    title: actual.title,
  });
}
