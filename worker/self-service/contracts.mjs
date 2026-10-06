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
  processingConcurrency: 2,
  testCooldownMs: 60000,
  testsPerDay: 3,
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
