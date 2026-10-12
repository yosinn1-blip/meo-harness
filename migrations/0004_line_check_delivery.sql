CREATE TABLE line_check_deliveries (
 store_id TEXT PRIMARY KEY REFERENCES line_links(store_id) ON DELETE CASCADE,
 generation INTEGER NOT NULL, session_hash TEXT NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('preparing','sending','sent','uncertain','held','failed')),
 error_code TEXT, expires_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
