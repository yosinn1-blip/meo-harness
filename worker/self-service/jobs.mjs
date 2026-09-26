export async function claimJob(ctx, { id, stage, leaseMs = 60000 }) {
  const leaseId = crypto.randomUUID();
  return ctx.db
    .prepare(
      `UPDATE review_jobs SET stage=?,lease_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND stage=? AND (lease_until IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM stores s WHERE s.id=review_jobs.store_id AND s.state='active' AND s.generation=review_jobs.generation) RETURNING *`,
    )
    .bind(
      stage === "fetched" ? "drafting" : stage,
      leaseId,
      ctx.now() + leaseMs,
      ctx.now(),
      id,
      stage,
      ctx.now(),
    )
    .first();
}
export async function finishJob(ctx, { id, leaseId, stage }) {
  const r = await ctx.db
    .prepare(
      "UPDATE review_jobs SET stage=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=? AND EXISTS(SELECT 1 FROM stores s WHERE s.id=review_jobs.store_id AND s.state='active' AND s.generation=review_jobs.generation)",
    )
    .bind(stage, ctx.now(), id, leaseId)
    .run();
  return r.meta.changes === 1;
}
