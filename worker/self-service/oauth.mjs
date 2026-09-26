import { jwtVerify, createLocalJWKSet } from "jose";
import { SelfError, ensure } from "./errors.mjs";
import { readSelfConfig } from "./config.mjs";
import { LIMITS, SELF_COOKIE } from "./contracts.mjs";
import {
  randomToken,
  sha256,
  seal,
  unseal,
  base64,
  tokenKey,
} from "./crypto.mjs";
import { requireMutation, readSession } from "./session.mjs";
import { consumeRate, verifyChallenge, ipBucket } from "./abuse.mjs";
import { googleJson } from "./google.mjs";
import { findOwnedStore } from "./store-repository.mjs";
export async function verifyGoogleIdToken(
  token,
  { jwks, clientId, nonce, now = Date.now },
) {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
      algorithms: ["RS256"],
      currentDate: new Date(now()),
      requiredClaims: ["iss", "sub", "aud", "iat", "exp"],
      clockTolerance: 30,
    });
    ensure(
      payload.nonce === nonce &&
        (!payload.azp || payload.azp === clientId) &&
        typeof payload.sub === "string" &&
        payload.sub.length > 0 &&
        payload.sub.length < 256,
      "GOOGLE_IDENTITY_INVALID",
      401,
    );
    return { sub: payload.sub };
  } catch {
    throw new SelfError("GOOGLE_IDENTITY_INVALID", 401);
  }
}
export async function startGoogle(ctx, request, { intent, challenge }) {
  ensure(["connect", "login", "reconnect"].includes(intent), "INVALID_INTENT");
  const c = readSelfConfig(ctx.env);
  ensure(c.configured, "REGISTRATION_CLOSED", 503);
  const actor = await requireMutation(ctx, request, { anonymous: true });
  if (intent === "reconnect") ensure(actor.sub, "LOGIN_REQUIRED", 401);
  if (intent === "connect") {
    ensure(c.registrationEnabled, "REGISTRATION_CLOSED", 503);
    const count = await ctx.db
      .prepare("SELECT count(*) n FROM location_claims WHERE mode='self'")
      .first();
    ensure(
      count.n < c.limits.maxActiveStores ||
        (actor.sub && (await findOwnedStore(ctx, actor.sub))),
      "CAPACITY_UNAVAILABLE",
      409,
    );
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await consumeRate(ctx, {
    bucket: "start:" + (await ipBucket(ctx, ip)),
    limit: 10,
    windowMs: 600000,
  });
  await verifyChallenge(ctx, { token: challenge, ip, action: "self_start" });
  const state = randomToken(),
    nonce = randomToken(),
    verifier = randomToken(48),
    hash = await sha256(state);
  const store = actor.sub ? await findOwnedStore(ctx, actor.sub) : null;
  const cc = base64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM oauth_attempts WHERE session_hash=?")
      .bind(actor.sessionHash),
    ctx.db
      .prepare(
        "INSERT INTO oauth_attempts(state_hash,session_hash,intent,verifier_ciphertext,nonce,owner_sub,store_id,generation,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        hash,
        actor.sessionHash,
        intent,
        await seal(verifier, tokenKey(ctx), "oauth:" + hash),
        nonce,
        actor.sub,
        store?.id ?? null,
        store?.generation ?? null,
        ctx.now() + LIMITS.oauthMs,
      ),
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: ctx.env.GBP_OAUTH_CLIENT_ID,
    redirect_uri: c.origin + "/api/self/google/callback",
    response_type: "code",
    scope:
      intent === "login"
        ? "openid"
        : "openid https://www.googleapis.com/auth/business.manage",
    state,
    nonce,
    code_challenge: cc,
    code_challenge_method: "S256",
    ...(intent !== "login"
      ? { access_type: "offline", prompt: "consent" }
      : {}),
  }).toString();
  return { authorizationUrl: url.toString() };
}
export async function finishGoogle(ctx, request) {
  const u = new URL(request.url),
    state = u.searchParams.get("state");
  const session = await readSession(ctx, request);
  ensure(session && state && state.length < 200, "OAUTH_STATE_INVALID", 400);
  const hash = await sha256(state);
  const attempt = await ctx.db
    .prepare(
      "DELETE FROM oauth_attempts WHERE state_hash=? AND session_hash=? AND expires_at>? RETURNING *",
    )
    .bind(hash, session.token_hash, ctx.now())
    .first();
  ensure(attempt, "OAUTH_STATE_INVALID");
  ensure(!u.searchParams.has("error"), "GOOGLE_PERMISSION_DENIED", 403);
  const code = u.searchParams.get("code");
  ensure(code && code.length < 4096, "OAUTH_CODE_INVALID");
  const data = await googleJson(ctx, "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: ctx.env.GBP_OAUTH_CLIENT_ID,
      client_secret: ctx.env.GBP_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: ctx.env.SELF_PUBLIC_ORIGIN + "/api/self/google/callback",
      grant_type: "authorization_code",
      code_verifier: await unseal(
        attempt.verifier_ciphertext,
        tokenKey(ctx),
        "oauth:" + hash,
      ),
    }),
  });
  const jwks = await googleJson(
    ctx,
    "https://www.googleapis.com/oauth2/v3/certs",
  );
  const { sub } = await verifyGoogleIdToken(data.id_token, {
    jwks,
    clientId: ctx.env.GBP_OAUTH_CLIENT_ID,
    nonce: attempt.nonce,
    now: ctx.now,
  });
  ensure(
    !attempt.owner_sub || attempt.owner_sub === sub,
    "GOOGLE_ACCOUNT_MISMATCH",
    403,
  );
  let ciphertext = null;
  if (attempt.intent !== "login") {
    ensure(
      data.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/business.manage"),
      "GOOGLE_PERMISSION_DENIED",
      403,
    );
    const previous = await ctx.db
      .prepare("SELECT ciphertext FROM google_credentials WHERE owner_sub=?")
      .bind(sub)
      .first();
    ciphertext = data.refresh_token
      ? await seal(data.refresh_token, tokenKey(ctx), "google:" + sub)
      : previous?.ciphertext;
    ensure(ciphertext, "GOOGLE_RECONNECT_REQUIRED", 401);
  }
  const secret = randomToken(),
    csrf = randomToken(),
    newHash = await sha256(secret),
    n = ctx.now();
  const statements = [
    ctx.db
      .prepare("INSERT INTO users VALUES (?,?) ON CONFLICT DO NOTHING")
      .bind(sub, n),
    ctx.db
      .prepare(
        `INSERT INTO sessions(token_hash,owner_sub,csrf,expires_at,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) AND (? IS NULL OR EXISTS(SELECT 1 FROM stores WHERE id=? AND generation=? AND state<>'disconnected'))`,
      )
      .bind(
        newHash,
        sub,
        csrf,
        n + LIMITS.sessionMs,
        n,
        session.token_hash,
        n,
        attempt.store_id,
        attempt.store_id,
        attempt.generation,
      ),
  ];
  if (ciphertext)
    statements.push(
      ctx.db
        .prepare(
          "INSERT INTO google_credentials(owner_sub,ciphertext,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=?) ON CONFLICT(owner_sub) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",
        )
        .bind(sub, ciphertext, n, newHash),
    );
  if (attempt.intent === "reconnect")
    statements.push(
      ctx.db
        .prepare(
          "UPDATE stores SET generation=generation+1,state=CASE WHEN line_verified_at IS NOT NULL THEN 'paused' ELSE 'location_selected' END,last_error=NULL,updated_at=? WHERE owner_sub=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)",
        )
        .bind(n, sub, newHash),
    );
  statements.push(
    ctx.db
      .prepare("DELETE FROM oauth_attempts WHERE session_hash=?")
      .bind(session.token_hash),
    ctx.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(session.token_hash),
  );
  const results = await ctx.db.batch(statements);
  ensure(results[1].meta.changes === 1, "OAUTH_STATE_INVALID");
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/account",
      "Set-Cookie": `${SELF_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
