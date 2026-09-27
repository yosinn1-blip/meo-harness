// Tells the operator on LINE that a store started using the service.
// Best effort: a failure here must never block the owner's activation.
export async function notifyOperatorActivation(ctx, { title, maxStores }) {
  const to = ctx.env.SELF_OPERATOR_LINE_USER_ID;
  const token = ctx.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!/^U[0-9a-f]{32}$/.test(to ?? "") || !token) return;
  try {
    const row = await ctx.db
      .prepare("SELECT count(*) n FROM stores WHERE state='active'")
      .first();
    const text =
      `MEO Harness: 新しいお店が利用を開始しました\n${String(title).slice(0, 100)}\n` +
      `稼働中 ${row.n}/${maxStores}店舗`;
    await ctx.fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}
