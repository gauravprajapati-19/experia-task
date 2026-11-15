-- Up Migration

CREATE TABLE merchants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'merchant')),
  merchant_id    uuid NULL REFERENCES merchants (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- every non-admin user belongs to exactly one merchant
  CONSTRAINT users_merchant_required CHECK (role = 'admin' OR merchant_id IS NOT NULL)
);

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           uuid NOT NULL REFERENCES merchants (id),
  reference             text NOT NULL UNIQUE,
  amount_paise          bigint NOT NULL CHECK (amount_paise > 0),
  currency              text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status                text NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  idempotency_key       text NOT NULL,
  request_hash          text NOT NULL,
  provider_payment_id   text NULL,
  needs_reconciliation  boolean NOT NULL DEFAULT false,
  last_provider_error   text NULL,
  description           text NULL,
  customer_email        text NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- idempotent initiation: one payment per (merchant, Idempotency-Key), enforced by the database
  CONSTRAINT payments_merchant_idempotency_key UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX payments_merchant_created_idx ON payments (merchant_id, created_at DESC);
CREATE INDEX payments_merchant_status_idx ON payments (merchant_id, status);
CREATE INDEX payments_provider_payment_id_idx ON payments (provider_payment_id);
CREATE INDEX payments_needs_reconciliation_idx ON payments (needs_reconciliation) WHERE needs_reconciliation;

CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- duplicate guard #1: each provider event is stored (and processed) at most once
  provider_event_id  text NOT NULL UNIQUE,
  payment_reference  text NOT NULL,
  payment_id         uuid NULL REFERENCES payments (id),
  event_status       text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  payload            jsonb NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('applied', 'duplicate', 'stale', 'invalid_transition', 'unknown_payment'))
);

CREATE INDEX webhook_events_payment_idx ON webhook_events (payment_id, received_at);

CREATE TABLE payment_audit_log (
  id           bigserial PRIMARY KEY,
  payment_id   uuid NOT NULL REFERENCES payments (id),
  from_status  text NULL,
  to_status    text NOT NULL,
  source       text NOT NULL CHECK (source IN ('api', 'webhook', 'reconciliation')),
  source_ref   text NULL,
  actor        text NULL,
  note         text NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_audit_log_payment_idx ON payment_audit_log (payment_id, id);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  payment_id    uuid NOT NULL REFERENCES payments (id),
  merchant_id   uuid NOT NULL,
  entry_type    text NOT NULL CHECK (entry_type IN ('CAPTURE')),
  amount_paise  bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- duplicate guard #3: at most one CAPTURE per payment, whatever path tries to write it
  CONSTRAINT ledger_entries_payment_entry_type UNIQUE (payment_id, entry_type)
);

-- The simulated external provider's own store, deliberately separate from `payments`
-- so reconciliation compares two independent sources of truth.
CREATE TABLE mock_provider_payments (
  provider_payment_id  text PRIMARY KEY,
  payment_reference    text NOT NULL UNIQUE,
  amount_paise         bigint NOT NULL,
  status               text NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz NULL,
  checked      int NOT NULL DEFAULT 0,
  resolved     int NOT NULL DEFAULT 0,
  mismatches   int NOT NULL DEFAULT 0,
  unresolved   int NOT NULL DEFAULT 0,
  report       jsonb NULL
);

CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);

-- Append-only tables: any UPDATE or DELETE statement raises, even one matching zero rows.
CREATE FUNCTION forbid_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER payment_audit_log_append_only
  BEFORE UPDATE OR DELETE ON payment_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_change();

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_change();

-- Down Migration

DROP TABLE IF EXISTS reconciliation_runs;
DROP TABLE IF EXISTS mock_provider_payments;
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS payment_audit_log;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS merchants;
DROP FUNCTION IF EXISTS forbid_append_only_change();
