export const LIMITS = Object.freeze({
  sessionMs: 86400000,
  oauthMs: 600000,
  linkMs: 900000,
  pinMs: 300000,
  pinAttempts: 5,
  firstPollDays: 60,
  batchReviews: 5,
  requestBytes: 16384,
  webhookBytes: 262144,
  // One poll slot reads one 20-review page; a store is polled at most every 2h.
  googlePageSize: 20,
  googlePagesPerRun: 1,
  pollMinIntervalMs: 7200000,
  // A digest waits until its oldest draft was fetched >=1h ago, and for up to
  // 4h for a batch of five while more reviews are still being drafted.
  notifyMinAgeMs: 3600000,
  notifyBatchWaitMs: 14400000,
  // A digest attempt (new or retry) starts only from JST 09:00 to 20:59; the
  // check is at the start, so one begun at 20:59:59 may reach LINE a few
  // seconds after 21:00 (bounded by the request timeouts). That is far from
  // midnight, so the daily limit never sees an acceptance on the next JST day.
  notifyEndHourJst: 21,
  // The review text is kept for 7 days from the fetch (purgeExpired); a draft
  // whose review is older can no longer be delivered.
  reviewKeepMs: 7 * 86400000,
  processingConcurrency: 2,
  testCooldownMs: 60000,
  testsPerDay: 3,
  // A registration that never started (no accepted terms) holds an intake slot
  // for 2h from creation until LINE is verified, and for 24h from creation in
  // total. Counted from created_at so a LINE code or reconnect cannot extend it.
  unstartedPreLineMs: 2 * 3600000,
  unstartedMs: 86400000,
});
export const SELF_LINE_PREFIX = "MEOS-";
export const SELF_REPLY_PREFIX = "ss_";
export const SELF_COOKIE = "__Host-meo_session";
export const STATES = [
  "google_connected",
  "location_selected",
  "line_pending",
  "line_verified",
  "ready",
  "active",
  "paused",
  "needs_google_reconnect",
  "disconnected",
];
export function dateKeys(now) {
  const d = new Date(now + 9 * 3600000).toISOString();
  return { day: d.slice(0, 10), month: d.slice(0, 7) };
}
export function jstHour(now) {
  return new Date(now + 9 * 3600000).getUTCHours();
}
// Epoch ms of 00:00 JST on the JST day containing `now`.
export function jstDayStart(now) {
  return Date.parse(dateKeys(now).day + "T00:00:00Z") - 9 * 3600000;
}
