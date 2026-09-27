CREATE TABLE reply_revisions (
 reply_id TEXT PRIMARY KEY, rev INTEGER NOT NULL CHECK(rev >= 2)
);
CREATE TABLE line_edits (
 line_user_id TEXT PRIMARY KEY, reply_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX line_edits_expiry ON line_edits(expires_at);
