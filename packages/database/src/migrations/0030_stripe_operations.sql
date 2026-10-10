ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_account_id varchar(255);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
 event_id varchar(255) PRIMARY KEY, property_id uuid REFERENCES properties(id),
 event_type varchar(100) NOT NULL, livemode boolean NOT NULL,
 processed_at timestamptz, dispatched_at timestamptz,
 consequences jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS direct_booking_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
 key_hash varchar(64) NOT NULL, request_hash varchar(64) NOT NULL,
 reservation_id uuid REFERENCES reservations(id), payment_id uuid REFERENCES payments(id),
 response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS direct_booking_attempts_property_key_unique ON direct_booking_attempts(property_id,key_hash);
CREATE TABLE IF NOT EXISTS stripe_checkouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
 reservation_id uuid NOT NULL REFERENCES reservations(id), payment_id uuid NOT NULL REFERENCES payments(id),
 stripe_account_id varchar(255) NOT NULL, session_id varchar(255), session_url text, closed_at timestamptz, return_url text NOT NULL, expires_at timestamptz NOT NULL,
 auto_confirm boolean NOT NULL, refundable boolean NOT NULL,
 reconciliation_required boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_checkouts_property_payment_unique ON stripe_checkouts(property_id,payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_checkouts_session_unique ON stripe_checkouts(session_id);
CREATE INDEX IF NOT EXISTS stripe_checkouts_expiry_idx ON stripe_checkouts(expires_at);
CREATE TABLE IF NOT EXISTS stripe_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
 folio_id uuid NOT NULL REFERENCES folios(id), document_id uuid NOT NULL REFERENCES fiscal_documents(id),
 payment_id uuid NOT NULL REFERENCES payments(id), stripe_account_id varchar(255) NOT NULL, customer_id varchar(255), invoice_id varchar(255),
 amount numeric(12,2) NOT NULL, currency_code varchar(3) NOT NULL, due_days varchar(3) NOT NULL, billing_email text NOT NULL, billing_name text NOT NULL, description text NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'creating', hosted_url text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_invoices_property_document_unique ON stripe_invoices(property_id,document_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_invoices_invoice_unique ON stripe_invoices(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_invoices_one_active_folio ON stripe_invoices(property_id,folio_id)
 WHERE status IN ('creating','draft','open','uncollectible');

-- Freeze collectible charge snapshots at the canonical ledger boundary. Locking
-- the folio serializes charge mutations with invoice issuance, even for other
-- PMS engines writing through supported HAIP services. Night-audit lock flags
-- and other non-financial annotations remain writable.
CREATE OR REPLACE FUNCTION guard_stripe_invoice_charges() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scoped_folio uuid; scoped_property uuid;
BEGIN
 IF TG_OP = 'UPDATE' AND ROW(OLD.folio_id,OLD.property_id,OLD.amount,OLD.tax_amount,OLD.currency_code)
    IS NOT DISTINCT FROM ROW(NEW.folio_id,NEW.property_id,NEW.amount,NEW.tax_amount,NEW.currency_code) THEN
  RETURN NEW;
 END IF;
 FOR scoped_folio, scoped_property IN
  SELECT DISTINCT x.folio_id,x.property_id FROM (
   SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.folio_id END AS folio_id,
          CASE WHEN TG_OP <> 'INSERT' THEN OLD.property_id END AS property_id
   UNION ALL
   SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.folio_id END,
          CASE WHEN TG_OP <> 'DELETE' THEN NEW.property_id END
  ) x WHERE x.folio_id IS NOT NULL ORDER BY x.folio_id
 LOOP
  PERFORM 1 FROM folios WHERE id=scoped_folio AND property_id=scoped_property FOR UPDATE;
  IF EXISTS (SELECT 1 FROM stripe_invoices WHERE folio_id=scoped_folio AND property_id=scoped_property
    AND status IN ('creating','draft','open','uncollectible')) THEN
   RAISE EXCEPTION 'Void the collectible Stripe invoice before changing folio charges' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_stripe_invoice_charges ON charges;
CREATE TRIGGER guard_stripe_invoice_charges BEFORE INSERT OR UPDATE OR DELETE ON charges
 FOR EACH ROW EXECUTE FUNCTION guard_stripe_invoice_charges();
