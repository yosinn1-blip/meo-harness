import { Miniflare } from "miniflare";
export async function withD1(t) {
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: "2024-11-01",
    script: 'export default {fetch(){return new Response("test-only")}}',
    d1Databases: ["SELF_DB"],
    kvNamespaces: ["STORES"],
    outboundService: () => {
      throw new Error("UNEXPECTED_EXTERNAL_IO");
    },
  });
  t.after(() => mf.dispose());
  return { db: await mf.getD1Database("SELF_DB"), mf };
}
export function fixtureEnv(db, overrides = {}) {
  return {
    SELF_DB: db,
    SELF_PUBLIC_ORIGIN: "https://meo.test",
    SELF_REGISTRATION_ENABLED: "true",
    SELF_PROCESSING_ENABLED: "true",
    SELF_MAX_ACTIVE_STORES: "1",
    SELF_MONTHLY_DRAFT_LIMIT: "1",
    SELF_MONTHLY_PUSH_LIMIT: "3",
    SELF_LEGACY_PUSH_RESERVE: "0",
    SELF_TERMS_VERSION: "fixture-v1",
    SELF_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
    SELF_RATE_KEY: "fixture-rate",
    TURNSTILE_SECRET_KEY: "fixture-turnstile",
    TURNSTILE_SITE_KEY: "fixture-site",
    SELF_LINE_FRIEND_URL: "https://meo.test/line",
    GBP_OAUTH_CLIENT_ID: "fixture-client",
    GBP_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "fixture-line",
    LINE_CHANNEL_SECRET: "fixture-line-secret",
    GROQ_API_KEY: "fixture-groq",
    ...overrides,
  };
}
import { readFile } from "node:fs/promises";
import {
  claimLocation,
  findOwnedStore,
} from "../../worker/self-service/store-repository.mjs";
export async function applySchema(db) {
  const sql = await readFile(
    new URL("../../migrations/0001_self_service.sql", import.meta.url),
    "utf8",
  );
  const statements = sql.match(/\s*CREATE TRIGGER[\s\S]+?END;|[^;]+;/g) || [];
  await db.batch(statements.map((s) => db.prepare(s.trim())));
}
export async function seedStore(
  ctx,
  { sub = "alice", state = "active", lineUserId = "line-a" } = {},
) {
  const store = await claimLocation(ctx, {
    sub,
    accountId: "accounts/1",
    locationId: "locations/2",
    title: "架空店",
  });
  await ctx.db
    .prepare(
      "UPDATE stores SET state=?,line_user_id=?,line_verified_at=?,terms_version=CASE WHEN ? IN ('active','paused') THEN 'fixture-v1' ELSE NULL END WHERE id=?",
    )
    .bind(state, lineUserId, ctx.now(), state, store.id)
    .run();
  return findOwnedStore(ctx, sub);
}
