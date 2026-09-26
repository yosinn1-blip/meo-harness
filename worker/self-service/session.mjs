import { LIMITS, SELF_COOKIE } from "./contracts.mjs";
import { randomToken, sha256, safeEqual } from "./crypto.mjs";
import { ensure } from "./errors.mjs";
export async function createSession(ctx, sub) {
  const secret = randomToken(),
    csrf = randomToken(),
    sessionHash = await sha256(secret);
  await ctx.db
    .prepare(
      "INSERT INTO sessions(token_hash,owner_sub,csrf,expires_at,created_at) VALUES (?,?,?,?,?)",
    )
    .bind(sessionHash, sub, csrf, ctx.now() + LIMITS.sessionMs, ctx.now())
    .run();
  return {
    cookie: `${SELF_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    csrf,
    sessionHash,
  };
}
export async function readSession(ctx, request) {
  const raw = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(SELF_COOKIE + "="))
    ?.slice(SELF_COOKIE.length + 1);
  if (!raw || !/^[\w-]{43}$/.test(raw) || !ctx.db) return null;
  return ctx.db
    .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?")
    .bind(await sha256(raw), ctx.now())
    .first();
}
export async function requireActor(ctx, request) {
  const s = await readSession(ctx, request);
  ensure(s?.owner_sub, "LOGIN_REQUIRED", 401);
  return { sub: s.owner_sub, sessionHash: s.token_hash, csrf: s.csrf };
}
export async function requireMutation(
  ctx,
  request,
  { anonymous = false } = {},
) {
  ensure(
    request.headers.get("Origin") === ctx.env.SELF_PUBLIC_ORIGIN,
    "ORIGIN_DENIED",
    403,
  );
  const s = await readSession(ctx, request);
  ensure(s && (anonymous || s.owner_sub), "LOGIN_REQUIRED", 401);
  ensure(
    safeEqual(s.csrf, request.headers.get("X-CSRF-Token")),
    "CSRF_INVALID",
    403,
  );
  return { sub: s.owner_sub, sessionHash: s.token_hash, csrf: s.csrf };
}
export async function revokeSession(ctx, hash) {
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM oauth_attempts WHERE session_hash=?")
      .bind(hash),
    ctx.db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(hash),
  ]);
}
export function expiredCookie() {
  return `${SELF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
