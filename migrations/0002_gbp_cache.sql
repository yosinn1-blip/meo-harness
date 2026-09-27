ALTER TABLE stores ADD COLUMN metadata_fetched_at INTEGER;
CREATE INDEX stores_metadata_expiry ON stores(metadata_fetched_at);
