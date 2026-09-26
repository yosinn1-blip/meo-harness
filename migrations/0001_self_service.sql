PRAGMA foreign_keys = ON;
CREATE TABLE users (sub TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE stores (
 id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL UNIQUE REFERENCES users(sub),
 account_id TEXT NOT NULL, location_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
 line_user_id TEXT, pending_line_user_id TEXT, terms_version TEXT, line_verified_at INTEGER, last_polled_at INTEGER, last_error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE location_claims (
 location_id TEXT PRIMARY KEY, store_id TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL CHECK(mode IN ('legacy','self'))
);
CREATE TABLE google_credentials (
 owner_sub TEXT PRIMARY KEY REFERENCES users(sub), ciphertext TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, owner_sub TEXT, csrf TEXT NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, notice TEXT
);
CREATE TABLE oauth_attempts (
 state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, intent TEXT NOT NULL,
 verifier_ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, owner_sub TEXT, store_id TEXT, generation INTEGER,
 expires_at INTEGER NOT NULL
);
CREATE TABLE line_links (
 code_hash TEXT PRIMARY KEY, store_id TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE line_checks (
 store_id TEXT PRIMARY KEY, pin_hash TEXT NOT NULL, generation INTEGER NOT NULL,
 session_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
);
CREATE TABLE usage_budgets (
 scope TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL,
 cap INTEGER NOT NULL CHECK(cap>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
 PRIMARY KEY(scope,period,kind)
);
CREATE TABLE usage_reservations (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units>0), state TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE review_jobs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL, review_id TEXT NOT NULL,
 review_version TEXT NOT NULL, generation INTEGER NOT NULL, stage TEXT NOT NULL,
 payload_ciphertext TEXT, lease_id TEXT, lease_until INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(store_id,review_id,review_version,generation)
);
CREATE TABLE replies (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL,
 generation INTEGER NOT NULL, draft_ciphertext TEXT, draft_hash TEXT NOT NULL,
 state TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE notification_jobs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL, generation INTEGER NOT NULL,
 day_key TEXT NOT NULL, part INTEGER NOT NULL, retry_key TEXT NOT NULL UNIQUE,
 payload_ciphertext TEXT, state TEXT NOT NULL, first_attempt_at INTEGER,
 accepted_request_id TEXT, lease_id TEXT, lease_until INTEGER,
 UNIQUE(store_id,day_key,part)
);
CREATE TABLE notification_items (
 notification_id TEXT NOT NULL, reply_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(notification_id,reply_id)
);
CREATE TABLE location_cursors (
 token_hash TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, payload_ciphertext TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, store_id TEXT, actor_hash TEXT, action TEXT NOT NULL,
 result_code TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE poll_cursors (
 store_id TEXT PRIMARY KEY, page_token TEXT, scan_started_at INTEGER,
 latest_completed_at INTEGER, cutoff_at INTEGER
);
CREATE TABLE rate_limits (
 bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON review_jobs(stage,next_attempt_at);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX audit_expiry ON audit_events(created_at);
CREATE TABLE location_candidates(owner_sub TEXT NOT NULL,account_id TEXT NOT NULL,location_id TEXT NOT NULL,title TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(owner_sub,account_id,location_id));
CREATE TRIGGER reservation_within_budget BEFORE INSERT ON usage_reservations
WHEN NOT EXISTS(SELECT 1 FROM usage_reservations r WHERE r.id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM usage_budgets b WHERE b.scope=NEW.scope
 AND b.period=NEW.period AND b.kind=NEW.kind AND b.used+NEW.units<=b.cap)
BEGIN SELECT RAISE(ABORT,'QUOTA_EXHAUSTED'); END;
CREATE TRIGGER reservation_count AFTER INSERT ON usage_reservations
BEGIN UPDATE usage_budgets SET used=used+NEW.units
 WHERE scope=NEW.scope AND period=NEW.period AND kind=NEW.kind; END;
CREATE TRIGGER reservation_same_identity BEFORE INSERT ON usage_reservations
WHEN EXISTS(SELECT 1 FROM usage_reservations r WHERE r.id=NEW.id
 AND (r.scope<>NEW.scope OR r.period<>NEW.period OR r.kind<>NEW.kind OR r.units<>NEW.units))
BEGIN SELECT RAISE(ABORT,'RESERVATION_MISMATCH'); END;
CREATE TRIGGER reservation_release AFTER UPDATE OF state ON usage_reservations
WHEN NEW.state='released' AND OLD.state<>'released'
BEGIN UPDATE usage_budgets SET used=MAX(0,used-NEW.units) WHERE scope=NEW.scope AND period=NEW.period AND kind=NEW.kind; END;
CREATE TABLE mutation_guards(ok INTEGER NOT NULL CHECK(ok=1));
