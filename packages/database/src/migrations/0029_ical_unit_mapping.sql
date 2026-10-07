ALTER TABLE ical_feeds ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES rooms(id);
CREATE INDEX IF NOT EXISTS ical_feeds_property_room_idx ON ical_feeds(property_id, room_id);
