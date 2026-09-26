import { SelfError, ensure } from "./errors.mjs";
import { unseal, tokenKey } from "./crypto.mjs";
import { readText } from "./abuse.mjs";
export async function googleJson(ctx, url, init = {}) {
  let response;
  try {
    response = await ctx.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new SelfError("GOOGLE_UNAVAILABLE", 502);
  }
  let data;
  try {
    data = JSON.parse(await readText(response, 2 * 1024 * 1024));
  } catch {
    throw new SelfError("GOOGLE_UNAVAILABLE", 502);
  }
  if (!response.ok) {
    if (data.error === "invalid_grant")
      throw new SelfError("GOOGLE_RECONNECT_REQUIRED", 401);
    throw new SelfError(
      response.status === 403 || response.status === 404
        ? "LOCATION_NOT_ACCESSIBLE"
        : "GOOGLE_UNAVAILABLE",
      response.status === 403 || response.status === 404 ? 403 : 502,
    );
  }
  return data;
}
export async function googleAccessToken(ctx, sub) {
  const row = await ctx.db
    .prepare("SELECT ciphertext FROM google_credentials WHERE owner_sub=?")
    .bind(sub)
    .first();
  ensure(row, "GOOGLE_RECONNECT_REQUIRED", 401);
  try {
    const data = await googleJson(ctx, "https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: ctx.env.GBP_OAUTH_CLIENT_ID,
        client_secret: ctx.env.GBP_OAUTH_CLIENT_SECRET,
        refresh_token: await unseal(
          row.ciphertext,
          tokenKey(ctx),
          "google:" + sub,
        ),
        grant_type: "refresh_token",
      }),
    });
    ensure(typeof data.access_token === "string", "GOOGLE_UNAVAILABLE", 502);
    return data.access_token;
  } catch (error) {
    if (error.code === "GOOGLE_RECONNECT_REQUIRED")
      await ctx.db
        .prepare(
          "UPDATE stores SET state='needs_google_reconnect',generation=generation+1,last_error=? WHERE owner_sub=? AND state<>'disconnected'",
        )
        .bind(error.code, sub)
        .run();
    throw error;
  }
}
