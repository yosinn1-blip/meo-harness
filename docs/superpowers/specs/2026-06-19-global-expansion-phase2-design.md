# MEO Harness — Global Expansion Phase 2 Design

Date: 2026-06-19

## Scope

Three features to ship in order:
1. Production deploy of Phase 1 changes
2. Cron Trigger for daily digest mode
3. Review platform adapter (Yelp / Trustpilot)

---

## Feature 1: Production Deploy

No code changes. Steps:
- `git push origin main`
- `wrangler deploy`
- Verify `GET /health` returns `{ status: "ok" }`

---

## Feature 2: Cron Trigger + Daily Digest Mode

### Purpose

Some stores may prefer one daily summary over per-review pings. This adds an opt-in `daily-digest` mode that buffers reviews in KV and sends them together at 09:00 JST.

### KV Schema Addition

Existing store object gains one optional field:

```json
{
  "notifyMode": "immediate | daily-digest"
}
```

Default (omitted): `"immediate"` — existing behavior unchanged.

Pending buffer key: `pending:{storeId}` in the same `STORES` KV namespace.  
Value: JSON array of review objects `[{ star, text, name?, draft? }]`.  
No TTL — the cron handler clears the key after sending.

### `/review` Endpoint Change

When `store.notifyMode === 'daily-digest'`:
- Append incoming reviews to `pending:{storeId}` (merge with any existing buffer)
- Return `{ ok: true, buffered: N }` without sending a notification

Otherwise (immediate, default):
- Existing behavior: generate AI drafts → send notification → return result

### Cron Handler

`wrangler.toml` addition:
```toml
[triggers]
crons = ["0 0 * * *"]
```

00:00 UTC = 09:00 JST. Japan-only for now; timezone expansion deferred until international stores join.

Handler (`scheduled(controller, env, ctx)` in `worker/index.mjs`):
1. `env.STORES.list({ prefix: "pending:" })` — find all buffered stores
2. For each key `pending:{storeId}`:
   a. Read store config from `store:{storeId}`
   b. Read pending reviews from `pending:{storeId}`
   c. Generate AI drafts via `generateReply` (parallel, best-effort)
   d. Send digest via `sendDigest`
   e. Delete `pending:{storeId}`
3. If step d fails, log error but still delete buffer (avoid infinite retry)

### Error Handling

- Store config missing → skip and delete orphaned pending key
- AI generation failure → include review in digest with `draft: null`; still send and delete buffer
- Notification failure → log error, **do not delete buffer**; reviews survive to next cron run

### Testing

Pure-function helpers extracted to `src/cron.mjs`:
- `mergePendingReviews(existing, incoming)` — append incoming to existing array
- `shouldSendDigest(store)` — returns true when mode is daily-digest (future: timezone check)

Worker `scheduled()` handler tested via mock `env.STORES`.

---

## Feature 3: Review Platform Adapter

### Purpose

Accept webhooks from Yelp and Trustpilot, normalize their payloads to the internal review format, and route to the existing AI draft + notification pipeline.

### `src/review-parser.mjs`

Single exported function:

```js
normalize(platform, rawReview) → { star, text, name?, platform, platformId? }
```

Platform adapters:

| Platform | `star` | `text` | `name` |
|---|---|---|---|
| `gbp` | pass-through | pass-through | pass-through |
| `yelp` | `raw.rating` | `raw.text` | `raw.user?.name` |
| `trustpilot` | `raw.stars` | `raw.text` | `raw.consumer?.displayName` |

Unknown platform → throws `Error("Unknown review platform: <platform>")`.

### New Worker Endpoints

```
POST /webhook/yelp          — Yelp review webhook
POST /webhook/trustpilot    — Trustpilot review webhook
```

Both require:
- `X-Store-Id` header — identifies which store the review belongs to
- `X-Webhook-Secret` header — HMAC-SHA256 signature of raw body (per-store secret stored in KV)

Flow:
1. Read `X-Store-Id`, look up store in KV
2. Validate HMAC signature against `store.webhookSecret`
3. Parse body, normalize via `review-parser.mjs`
4. Route to the same pipeline as `handleReview` (AI draft → notify based on `notifyMode`)

### KV Schema Addition

```json
{
  "webhookSecret": "<per-store random string>"
}
```

Set via `PUT /admin/stores/:id` (existing admin endpoint, just add the field).

### HMAC Validation

```js
async function verifyHmac(secret, rawBody, signature) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sig = hexToBytes(signature);
  const body = new TextEncoder().encode(rawBody);
  return crypto.subtle.verify("HMAC", key, sig, body);
}
```

Invalid signature → 401 Unauthorized.

### Testing

`test/review-parser.test.mjs`:
- Each platform adapter maps fields correctly
- Missing optional fields (`name`) → omitted from output
- Unknown platform throws
- Star clamping (0–5)

HMAC validation tested in `test/webhook.test.mjs` with known secret/signature pairs.

---

## Implementation Order

1. `git push` + `wrangler deploy` + health check
2. `src/cron.mjs` (pure helpers) → tests → Worker `scheduled()` handler → `wrangler.toml`
3. `src/review-parser.mjs` → tests → Worker webhook endpoints → HMAC tests

---

## What Is NOT in Scope

- Timezone-aware scheduling (all stores treated as JST for now)
- WhatsApp Business API provider
- GDPR/CCPA data retention
- Yelp/Trustpilot OAuth (webhook receipt only — no polling)
- UI for configuring `notifyMode` or `webhookSecret`
