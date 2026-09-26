export const LIMITS=Object.freeze({sessionMs:86400000,oauthMs:600000,linkMs:900000,pinMs:300000,pinAttempts:5,firstPollDays:60,batchReviews:5,requestBytes:16384,webhookBytes:262144,googlePageSize:50,googlePagesPerRun:2,processingConcurrency:2,testCooldownMs:60000,testsPerDay:3});
export const SELF_LINE_PREFIX='MEOS-';
export const SELF_REPLY_PREFIX='ss_';
export const SELF_COOKIE='__Host-meo_session';
export const STATES=['google_connected','location_selected','line_pending','line_verified','ready','active','paused','needs_google_reconnect','disconnected'];
export function dateKeys(now){const d=new Date(now+9*3600000).toISOString();return {day:d.slice(0,10),month:d.slice(0,7)};}
