-- Additive only: old PIN workers can keep using the existing tables.
CREATE TABLE line_button_checks (
 store_id TEXT PRIMARY KEY REFERENCES line_check_deliveries(store_id) ON DELETE CASCADE,
 owner_sub TEXT NOT NULL, generation INTEGER NOT NULL,
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 line_user_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 purpose TEXT NOT NULL CHECK(purpose='confirm_line_destination_v1'),
 nonce_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
 received_at INTEGER, consumed_at INTEGER
);
