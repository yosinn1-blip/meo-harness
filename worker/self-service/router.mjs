import { getSelfStatus } from "./status.mjs";
import {
  readSession,
  createSession,
  requireActor,
  requireMutation,
  revokeSession,
  expiredCookie,
} from "./session.mjs";
import { discoverLocations, selectLocation } from "./locations.mjs";
import { readBody, consumeRate, ipBucket } from "./abuse.mjs";
import { SelfError, publicError, ensure } from "./errors.mjs";
import { startGoogle, finishGoogle } from "./oauth.mjs";
import { issueLineCode, sendLineCheck, verifyLinePin } from "./line-link.mjs";
import { activateStore, pauseStore, disconnectStore } from "./lifecycle.mjs";
import { readOwnedReply } from "./approvals.mjs";
import { sha256 } from "./crypto.mjs";
export function selfJson(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
export async function handleSelfRequest(request, env, ctx) {
  const u = new URL(request.url),
    path = u.pathname;
  if (
    path === "/start" ||
    path === "/account" ||
    /^\/google[a-f0-9]{16}\.html$/.test(path) ||
    path.startsWith("/account/replies/") ||
    path.startsWith("/self/")
  ) {
    const { serveSelfPage } = await import("./views.mjs");
    return serveSelfPage(request, ctx);
  }
  if (!path.startsWith("/api/self/")) return null;
  try {
    if (!ctx.db) throw new SelfError("REGISTRATION_CLOSED", 503);
    if (path === "/api/self/google/callback" && request.method === "GET") {
      try {
        return await finishGoogle(ctx, request);
      } catch (e) {
        const s = await readSession(ctx, request);
        if (s)
          await ctx.db
            .prepare("UPDATE sessions SET notice=? WHERE token_hash=?")
            .bind(
              e instanceof SelfError ? e.code : "GOOGLE_UNAVAILABLE",
              s.token_hash,
            )
            .run();
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/account",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
    }
    if (path === "/api/self/status" && request.method === "GET") {
      let s = await readSession(ctx, request);
      if (!s) {
        await consumeRate(ctx, {
          bucket:
            "session:" +
            (await ipBucket(
              ctx,
              request.headers.get("CF-Connecting-IP") ?? "unknown",
            )),
          limit: 10,
          windowMs: 600000,
        });
        s = await createSession(ctx, null);
        return selfJson(
          { ...(await getSelfStatus(ctx, request)), csrf: s.csrf },
          200,
          { "Set-Cookie": s.cookie },
        );
      }
      return selfJson(await getSelfStatus(ctx, request));
    }
    if (path === "/api/self/google/start" && request.method === "POST")
      return selfJson({
        ok: true,
        ...(await startGoogle(ctx, request, await readBody(request))),
      });
    const actor =
      request.method === "POST"
        ? await requireMutation(ctx, request)
        : await requireActor(ctx, request);
    await consumeRate(ctx, {
      bucket: "api:" + actor.sub,
      limit: 60,
      windowMs: 60000,
    });
    if (path === "/api/self/locations" && request.method === "GET")
      return selfJson({
        ok: true,
        ...(await discoverLocations(ctx, actor, {
          cursor: u.searchParams.get("cursor"),
        })),
      });
    const replyMatch = /^\/api\/self\/replies\/(ss_[\w-]+)$/.exec(path);
    if (replyMatch && request.method === "GET")
      return selfJson({
        ok: true,
        ...(await readOwnedReply(ctx, actor, replyMatch[1])),
      });
    if (request.method !== "POST") throw new SelfError("NOT_FOUND", 404);
    const body = await readBody(request);
    let result = { ok: true },
      cookie;
    switch (path) {
      case "/api/self/location":
        await selectLocation(ctx, actor, body);
        break;
      case "/api/self/line/code":
        result = { ok: true, ...(await issueLineCode(ctx, actor)) };
        break;
      case "/api/self/line/test":
        result = await sendLineCheck(ctx, actor);
        break;
      case "/api/self/line/verify":
        result = await verifyLinePin(ctx, actor, body.pin);
        break;
      case "/api/self/activate":
        result = await activateStore(ctx, actor, body);
        break;
      case "/api/self/pause":
        ensure(body.confirmed === true, "CONFIRMATION_REQUIRED");
        result = await pauseStore(ctx, actor);
        break;
      case "/api/self/disconnect":
        ensure(body.confirmed === true, "CONFIRMATION_REQUIRED");
        result = await disconnectStore(ctx, actor);
        cookie = expiredCookie();
        break;
      case "/api/self/logout":
        await revokeSession(ctx, actor.sessionHash);
        cookie = expiredCookie();
        break;
      default:
        throw new SelfError("NOT_FOUND", 404);
    }
    await ctx.db
      .prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        null,
        await sha256(actor.sub),
        path.slice(10),
        "OK",
        ctx.now(),
      )
      .run();
    return selfJson(result, 200, cookie ? { "Set-Cookie": cookie } : {});
  } catch (e) {
    return selfJson(publicError(e), e instanceof SelfError ? e.status : 500);
  }
}
