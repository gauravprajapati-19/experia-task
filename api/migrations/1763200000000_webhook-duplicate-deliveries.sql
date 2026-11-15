-- Up Migration

-- Counts signature-valid repeat deliveries of an already stored event. Guard 1 still stores and
-- processes each provider_event_id once; this counter is visibility only and never moves money.
ALTER TABLE webhook_events
  ADD COLUMN duplicate_deliveries integer NOT NULL DEFAULT 0 CHECK (duplicate_deliveries >= 0);

-- Down Migration

ALTER TABLE webhook_events DROP COLUMN IF EXISTS duplicate_deliveries;
