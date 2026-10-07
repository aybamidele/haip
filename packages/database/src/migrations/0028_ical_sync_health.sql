ALTER TABLE ical_feeds ADD COLUMN IF NOT EXISTS last_successful_sync_at timestamptz;
ALTER TABLE ical_feeds ADD COLUMN IF NOT EXISTS consecutive_sync_failures integer NOT NULL DEFAULT 0;
UPDATE ical_feeds SET last_successful_sync_at = last_sync_at
WHERE last_sync_status = 'success' AND last_successful_sync_at IS NULL;
