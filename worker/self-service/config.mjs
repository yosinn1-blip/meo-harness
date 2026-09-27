export function nonNegativeInteger(v) {
  if (!/^(0|[1-9]\d*)$/.test(String(v ?? ""))) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}
export function readSelfConfig(env) {
  let origin;
  try {
    const u = new URL(env.SELF_PUBLIC_ORIGIN);
    if (u.protocol === "https:" && u.origin === env.SELF_PUBLIC_ORIGIN)
      origin = u.origin;
  } catch {}
  const limits = {
    maxActiveStores: nonNegativeInteger(env.SELF_MAX_ACTIVE_STORES),
    drafts: nonNegativeInteger(env.SELF_MONTHLY_DRAFT_LIMIT),
    pushes: nonNegativeInteger(env.SELF_MONTHLY_PUSH_LIMIT),
    legacyReserve: nonNegativeInteger(env.SELF_LEGACY_PUSH_RESERVE),
  };
  const keyOK =
    typeof env.SELF_TOKEN_KEY_V1 === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(env.SELF_TOKEN_KEY_V1);
  const configured = Boolean(
    env.SELF_DB &&
      origin &&
      keyOK &&
      env.GBP_OAUTH_CLIENT_ID &&
      env.GBP_OAUTH_CLIENT_SECRET &&
      env.SELF_RATE_KEY,
  );
  const operational = Boolean(
    configured &&
      env.LINE_CHANNEL_ACCESS_TOKEN &&
      env.LINE_CHANNEL_SECRET &&
      env.GROQ_API_KEY &&
      env.SELF_LEGACY_PUSH_RESERVE !== undefined &&
      /^(0|[1-9]\d*)$/.test(env.SELF_LEGACY_PUSH_RESERVE),
  );
  const registrationEnabled = Boolean(
    operational &&
      env.SELF_REGISTRATION_ENABLED === "true" &&
      limits.maxActiveStores > 0 &&
      limits.drafts > 0 &&
      limits.pushes > 0 &&
      env.TURNSTILE_SECRET_KEY &&
      env.TURNSTILE_SITE_KEY &&
      env.SELF_LINE_FRIEND_URL &&
      env.SELF_TERMS_VERSION,
  );
  return {
    origin,
    configured,
    registrationEnabled,
    processingEnabled: operational && env.SELF_PROCESSING_ENABLED === "true",
    limits,
  };
}
export function createSelfContext(
  env,
  // workerd requires its native fetch receiver, even when called as ctx.fetchImpl.
  { now = Date.now, fetchImpl = globalThis.fetch.bind(globalThis) } = {},
) {
  return { env, db: env.SELF_DB, now, fetchImpl };
}
