ALTER TABLE booking_engine_config ADD COLUMN IF NOT EXISTS allow_manual_payments boolean NOT NULL DEFAULT false;
ALTER TABLE booking_engine_config ADD COLUMN IF NOT EXISTS allow_enquiries boolean NOT NULL DEFAULT false;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS reservations_pending_hold_idx ON reservations (hold_expires_at) WHERE status = 'pending';
