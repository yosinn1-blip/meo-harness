import { readSelfConfig } from "./config.mjs";
import { LIMITS, dateKeys } from "./contracts.mjs";
import { getStore } from "./store-repository.mjs";
import { storeGuard } from "./lifecycle.mjs";
import { googleAccessToken } from "./google.mjs";
import { fetchGbpReviewsPage, normalizeGbpReview } from "../../src/gbp.mjs";
import { sha256, seal, unseal, tokenKey } from "./crypto.mjs";
import { generateReply, PROVIDERS } from "../../src/reply-engine.mjs";
import { claimJob } from "./jobs.mjs";
import { budgetStatement, draftBudgetScope, reserveUsage, settleUsage } from "./budget.mjs";
import { ensure } from "./errors.mjs";
export async function pollSelfStore(ctx, storeId) {
  if (!readSelfConfig(ctx.env).processingEnabled) return;
  const store = await getStore(ctx, storeId);
  if (store?.state !== "active") return;
  const token = await googleAccessToken(ctx, store.ownerSub);
  let cursor = await ctx.db
    .prepare("SELECT * FROM poll_cursors WHERE store_id=?")
    .bind(storeId)
    .first();
  let pageToken = cursor?.page_token ?? null;
  const cutoff =
    cursor?.cutoff_at ?? ctx.now() - LIMITS.firstPollDays * 86400000;
  for (let page = 0; page < LIMITS.googlePagesPerRun; page++) {
    let result;
    try {
      result = await fetchGbpReviewsPage({
        accessToken: token,
        accountId: store.accountId,
        locationId: store.locationId,
        pageToken,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (e) {
      if (pageToken && e.status === 400) {
        await ctx.db
          .prepare("UPDATE poll_cursors SET page_token=NULL WHERE store_id=?")
          .bind(storeId)
          .run();
        return;
      }
      throw e;
    }
    const statements = [storeGuard(ctx, store, ["active"])];
    for (const raw of result.items) {
      if (
        raw.reviewReply ||
        Date.parse(raw.createTime) < cutoff ||
        !Number.isFinite(Date.parse(raw.createTime)) ||
        typeof raw.reviewId !== "string"
      )
        continue;
      const review = normalizeGbpReview(raw);
      const version = await sha256(JSON.stringify(review));
      const id = await sha256(
        storeId + ":" + raw.reviewId + ":" + version + ":" + store.generation,
      );
      statements.push(
        ctx.db
          .prepare(
            "INSERT INTO review_jobs(id,store_id,review_id,review_version,generation,stage,payload_ciphertext,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,'fetched',?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE review_jobs.stage='fetched' AND review_jobs.payload_ciphertext IS NULL",
          )
          .bind(
            id,
            storeId,
            raw.reviewId,
            version,
            store.generation,
            await seal(JSON.stringify(review), tokenKey(ctx), "job:" + id),
            ctx.now(),
            ctx.now(),
            ctx.now(),
          ),
      );
    }
    statements.push(
      ctx.db
        .prepare(
          "INSERT INTO poll_cursors(store_id,page_token,scan_started_at,latest_completed_at,cutoff_at) VALUES (?,?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET page_token=excluded.page_token,latest_completed_at=COALESCE(excluded.latest_completed_at,latest_completed_at)",
        )
        .bind(
          storeId,
          result.nextPageToken,
          ctx.now(),
          result.nextPageToken ? null : ctx.now(),
          cutoff,
        ),
      ctx.db
        .prepare(
          "UPDATE stores SET last_polled_at=?,last_error=NULL WHERE id=?",
        )
        .bind(ctx.now(), storeId),
      ctx.db.prepare("DELETE FROM mutation_guards"),
    );
    await ctx.db.batch(statements);
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
}
export async function processSelfJobs(ctx, { limit = 5 } = {}) {
  const c = readSelfConfig(ctx.env);
  if (!c.processingEnabled || c.limits.drafts === 0) return;
  // A known successful generation whose write was interrupted is held, never bought again automatically.
  await ctx.db
    .prepare(
      "UPDATE review_jobs SET stage='draft_storage_held',lease_id=NULL,lease_until=NULL WHERE stage='drafting' AND lease_until<=? AND EXISTS(SELECT 1 FROM usage_reservations u WHERE u.id='draft:'||review_jobs.id||':'||review_jobs.attempts AND u.state='committed')",
    )
    .bind(ctx.now())
    .run();
  // Other crashed attempts retain their charged reservation; retry is bounded.
  await ctx.db
    .prepare(
      "UPDATE review_jobs SET stage='fetched',lease_id=NULL,lease_until=NULL WHERE stage='drafting' AND lease_until<=? AND attempts<5",
    )
    .bind(ctx.now())
    .run();
  await ctx.db
    .prepare(
      "UPDATE review_jobs SET stage='blocked',lease_id=NULL,lease_until=NULL WHERE stage='drafting' AND lease_until<=? AND attempts>=5",
    )
    .bind(ctx.now())
    .run();
  const candidates = await ctx.db
    .prepare(
      "SELECT j.* FROM review_jobs j JOIN stores s ON s.id=j.store_id WHERE j.stage='fetched' AND j.generation=s.generation AND s.state='active' AND j.next_attempt_at<=? AND j.payload_ciphertext IS NOT NULL ORDER BY j.created_at,j.id LIMIT ?",
    )
    .bind(ctx.now(), Math.min(limit, LIMITS.batchReviews))
    .all();
  for (const candidate of candidates.results) {
    const store = await getStore(ctx, candidate.store_id);
    const period = dateKeys(ctx.now()).month;
    const scope = draftBudgetScope(store);
    await budgetStatement(ctx, {
      scope,
      period,
      kind: "draft",
      cap: c.limits.drafts,
    }).run();
    const budget = await ctx.db
      .prepare(
        "SELECT used,cap FROM usage_budgets WHERE scope=? AND period=? AND kind='draft'",
      )
      .bind(scope, period)
      .first();
    if (budget.used >= budget.cap) continue;
    const job = await claimJob(ctx, { id: candidate.id, stage: "fetched" });
    if (!job) continue;
    const reservation = "draft:" + job.id + ":" + job.attempts;
    const reserved = await reserveUsage(ctx, {
      id: reservation,
      scope,
      period,
      kind: "draft",
      units: 1,
    });
    if (!reserved.ok) {
      await ctx.db
        .prepare(
          "UPDATE review_jobs SET stage='fetched',lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",
        )
        .bind(job.id, job.lease_id)
        .run();
      continue;
    }
    let validDraft = false;
    try {
      const current = await getStore(ctx, store.id);
      ensure(
        current?.state === "active" && current.generation === job.generation,
        "STORE_INACTIVE",
        409,
      );
      const review = JSON.parse(
        await unseal(job.payload_ciphertext, tokenKey(ctx), "job:" + job.id),
      );
      const draft = await generateReply({
        review,
        business: { name: store.title, type: "店舗" },
        provider: PROVIDERS.GROQ,
        providerConfig: { apiKey: ctx.env.GROQ_API_KEY },
        fetchImpl: (url, init) =>
          ctx.fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) }),
        maxRetries: 0,
      });
      await settleUsage(ctx, reservation, "committed");
      ensure(
        draft.text &&
          draft.text.length <= 1200 &&
          !draft.warnings.includes("hangul-contamination"),
        "DRAFT_INVALID",
        422,
      );
      validDraft = true;
      const replyId = "ss_" + job.id;
      const saveStatements = [
        storeGuard(ctx, store, ["active"]),
        ctx.db
          .prepare(
            "INSERT INTO mutation_guards SELECT EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND lease_id=?)",
          )
          .bind(job.id, job.lease_id),
        ctx.db
          .prepare(
            "INSERT INTO replies VALUES (?,?,?,?,?,?,'pending',?) ON CONFLICT(job_id) DO NOTHING",
          )
          .bind(
            replyId,
            job.id,
            store.id,
            store.generation,
            await seal(draft.text, tokenKey(ctx), "reply:" + replyId),
            await sha256(draft.text),
            ctx.now() + 7 * 86400000,
          ),
        ctx.db
          .prepare(
            "UPDATE review_jobs SET stage='draft_ready',lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?",
          )
          .bind(ctx.now(), job.id, job.lease_id),
        ctx.db.prepare("DELETE FROM mutation_guards"),
      ];
      for (let storageAttempt = 0; storageAttempt < 3; storageAttempt++) {
        try {
          await ctx.db.batch(saveStatements);
          break;
        } catch (error) {
          if (storageAttempt === 2) throw error;
        }
      }
    } catch (e) {
      await settleUsage(ctx, reservation, "uncertain");
      await ctx.db
        .prepare(
          "UPDATE review_jobs SET stage=?,lease_id=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_id=?",
        )
        .bind(
          validDraft
            ? "draft_storage_held"
            : job.attempts >= 5
              ? "blocked"
              : "fetched",
          ctx.now() + [60000, 300000, 1800000][Math.min(job.attempts - 1, 2)],
          ctx.now(),
          job.id,
          job.lease_id,
        )
        .run();
      await ctx.db
        .prepare("UPDATE stores SET last_error=? WHERE id=?")
        .bind(
          validDraft ? "DRAFT_STORAGE_HELD" : "DRAFT_RETRY_REQUIRED",
          store.id,
        )
        .run();
    }
  }
}
