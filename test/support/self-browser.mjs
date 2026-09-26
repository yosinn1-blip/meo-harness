import https from "node:https";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { withD1, applySchema, fixtureEnv } from "./self-runtime.mjs";
import { googleFixture } from "./self-google.mjs";
import { hmac } from "../../worker/self-service/crypto.mjs";
let module;
export async function startTestApp() {
  await mkdir("output/self-service", { recursive: true });
  if (!module) {
    const outfile = resolve("output/self-service/test-worker.mjs");
    await build({
      entryPoints: ["test/support/self-entry.mjs"],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      loader: {
        ".html": "text",
        ".css": "text",
        ".txt": "text",
        ".md": "text",
      },
    });
    module = await import(pathToFileURL(outfile));
  }
  const cert = "output/self-service/localhost-cert.pem",
    key = "output/self-service/localhost-key.pem";
  if (!existsSync(cert))
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  let dispose;
  const { db, mf } = await withD1({
    after(fn) {
      dispose = fn;
    },
  });
  await applySchema(db);
  let offset = 0;
  const now = () => Date.now() + offset;
  const f = await googleFixture({ now });
  const fixtureKey = crypto.randomUUID();
  const unexpected = [],
    writes = [],
    pushes = [],
    feedback = [];
  const settings = {
    locations: 1,
    googleFailure: false,
    registration: true,
    reviews: [],
    quota: 200,
    consumed: 0,
  };
  let env, ctx, baseURL, lastPin;
  const originalFetch = globalThis.fetch;
  const fetchImpl = async (input, init = {}) => {
    const u = new URL(input instanceof Request ? input.url : input);
    if (u.hostname === "challenges.cloudflare.com")
      return Response.json({
        success: true,
        hostname: "127.0.0.1",
        action: "self_start",
      });
    if (
      u.hostname === "oauth2.googleapis.com" ||
      u.pathname === "/oauth2/v3/certs"
    )
      return f.fetchImpl(input, init);
    if (
      u.hostname === "mybusinessaccountmanagement.googleapis.com" &&
      u.pathname === "/v1/accounts"
    )
      return Response.json({ accounts: [{ name: "accounts/1" }] });
    if (u.hostname === "mybusinessbusinessinformation.googleapis.com") {
      if (settings.googleFailure) return Response.json({}, { status: 500 });
      if (u.pathname.endsWith("/locations"))
        return Response.json({
          locations: Array.from({ length: settings.locations }, (_, i) => ({
            name: "locations/" + (i + 2),
            title: i ? "架空の支店" : "架空美容室",
          })),
        });
      if (/^\/v1\/locations\/[23]$/.test(u.pathname))
        return Response.json({
          name: u.pathname.slice(4),
          title: u.pathname.endsWith("2") ? "架空美容室" : "架空の支店",
        });
    }
    if (u.hostname === "mybusiness.googleapis.com") {
      if (init.method === "PUT") {
        const reply = JSON.parse(init.body);
        writes.push(reply);
        const review = settings.reviews.find((r) =>
          u.pathname.endsWith("/" + r.reviewId + "/reply"),
        );
        if (review) review.reviewReply = reply;
        return Response.json(reply);
      }
      const review = settings.reviews.find((r) =>
        u.pathname.endsWith("/reviews/" + r.reviewId),
      );
      return Response.json(review ?? { reviews: settings.reviews });
    }
    if (u.hostname === "api.groq.com")
      return Response.json({
        choices: [
          {
            message: {
              content:
                "ご来店ありがとうございました。またお会いできることを楽しみにしています。",
            },
          },
        ],
        usage: { total_tokens: 10 },
      });
    if (u.hostname === "api.line.me") {
      if (u.pathname.endsWith("/reply")) {
        feedback.push(JSON.parse(init.body));
        return Response.json({});
      }
      if (u.pathname.endsWith("/quota"))
        return Response.json({ type: "limited", value: settings.quota });
      if (u.pathname.endsWith("/consumption"))
        return Response.json({ totalUsage: settings.consumed });
      if (u.pathname.endsWith("/push")) {
        const body = JSON.parse(init.body);
        pushes.push(body);
        lastPin =
          body.messages[0]?.text?.match(/確認番号: (\d{6})/)?.[1] ?? lastPin;
        return Response.json(
          {},
          { headers: { "x-line-request-id": "fixture-accepted" } },
        );
      }
    }
    unexpected.push(u.origin + u.pathname);
    throw new Error("UNEXPECTED_EXTERNAL_IO");
  };
  // Legacy webhook enters the same production dispatch. Its default fetch is still fixture-only.
  globalThis.fetch = fetchImpl;
  const server = https.createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      try {
        const url = new URL(req.url, baseURL);
        let chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(!["GET", "HEAD"].includes(req.method)
            ? { body, duplex: "half" }
            : {}),
        });
        let response;
        if (url.pathname.startsWith("/fixture/")) {
          if (req.headers["x-fixture-key"] !== fixtureKey) {
            res.writeHead(403);
            res.end();
            return;
          }
          const data = body.length ? JSON.parse(body) : {};
          if (url.pathname === "/fixture/authorize") {
            const original = new URL(
              "https://accounts.google.com/o/oauth2/v2/auth",
            );
            original.search = url.search;
            const code = await f.authorize(original);
            const target =
              "/api/self/google/callback?state=" +
              encodeURIComponent(url.searchParams.get("state")) +
              "&code=" +
              encodeURIComponent(code);
            const denied =
              "/api/self/google/callback?state=" +
              encodeURIComponent(url.searchParams.get("state")) +
              "&error=access_denied";
            response = new Response(
              `<!doctype html><html lang="ja"><meta charset="utf-8"><h1>架空Google認可画面</h1><form action="${target}"><input type="hidden" name="state" value="${url.searchParams.get("state")}"><input type="hidden" name="code" value="${code}"><button>架空Googleで許可</button></form><form action="/api/self/google/callback"><input type="hidden" name="state" value="${url.searchParams.get("state")}"><input type="hidden" name="error" value="access_denied"><button>許可しない</button></form></html>`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
          } else if (
            ["/fixture/line", "/fixture/postback"].includes(url.pathname)
          ) {
            const raw = JSON.stringify({
              events: [
                {
                  type: data.action ? "postback" : "message",
                  postback: data.action ? { data: data.action } : undefined,
                  replyToken: "fixture-reply-" + crypto.randomUUID(),
                  webhookEventId: crypto.randomUUID(),
                  source: { type: "user", userId: data.userId },
                  message: { type: "text", text: data.code },
                },
              ],
            });
            const pending = [];
            response = await module.default.fetch(
              new Request(baseURL + "/webhook/line-bot", {
                method: "POST",
                body: raw,
                headers: {
                  "X-Line-Signature": await hmac(raw, env.LINE_CHANNEL_SECRET),
                },
              }),
              env,
              {
                waitUntil(p) {
                  pending.push(p);
                },
              },
            );
            await Promise.all(pending);
          } else if (url.pathname === "/fixture/pin")
            response = Response.json({ pin: lastPin });
          else if (url.pathname === "/fixture/scenario") {
            Object.assign(settings, data);
            env.SELF_REGISTRATION_ENABLED = String(settings.registration);
            if (data.drafts !== undefined)
              env.SELF_MONTHLY_DRAFT_LIMIT = String(data.drafts);
            if (data.activeLimit !== undefined)
              env.SELF_MAX_ACTIVE_STORES = String(data.activeLimit);
            response = Response.json({ ok: true });
          } else if (url.pathname === "/fixture/advance") {
            offset += data.ms;
            response = Response.json({ ok: true });
          } else if (url.pathname === "/fixture/cron") {
            await module.runSelfScheduled(ctx);
            response = Response.json({ ok: true });
          } else response = new Response(null, { status: 404 });
        } else {
          response =
            (await module.handleSelfRequest(request, env, ctx)) ??
            (await module.default.fetch(request, env, { waitUntil() {} }));
          if (url.pathname === "/api/self/google/start" && response.ok) {
            const data = await response.json();
            if (
              new URL(data.authorizationUrl).origin !==
              "https://accounts.google.com"
            )
              throw new Error("INVALID_AUTHORIZE_ORIGIN");
            const auth = new URL(data.authorizationUrl);
            auth.protocol = "https:";
            auth.host = new URL(baseURL).host;
            auth.pathname = "/fixture/authorize";
            response = Response.json({
              ...data,
              authorizationUrl: auth.toString(),
            });
          }
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            code: "TEST_SERVER_FAILED",
            message: e.message,
          }),
        );
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = "https://127.0.0.1:" + server.address().port;
  env = fixtureEnv(db, {
    SELF_PUBLIC_ORIGIN: baseURL,
    SELF_LINE_FRIEND_URL: "https://line.me/R/ti/p/@fixture",
    STORES: await mf.getKVNamespace("STORES"),
  });
  ctx = module.createSelfContext(env, { now, fetchImpl });
  return {
    baseURL,
    providerFixtureURL: baseURL + "/fixture/authorize",
    fixtureKey,
    unexpected,
    writes,
    pushes,
    feedback,
    db,
    ctx,
    async stop() {
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await dispose();
    },
  };
}
