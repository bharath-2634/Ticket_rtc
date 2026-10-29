CREATE TABLE tickets (
  id bigserial PRIMARY KEY,
  message_id text NOT NULL UNIQUE,
  original_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected')),
  rejection_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error text
);

CREATE INDEX tickets_status_created_idx ON tickets (status, created_at DESC, id DESC);
CREATE INDEX tickets_lease_idx ON tickets (lease_expires_at) WHERE status = 'processing';

CREATE TABLE ingestion_events (
  id bigserial PRIMARY KEY,
  message_id text,
  event_type text NOT NULL CHECK (
    event_type IN (
      'accepted', 'rejected', 'request_rejected', 'duplicate', 'payload_conflict', 'ingestion_error',
      'worker_claimed', 'worker_recovered', 'retry_requested'
    )
  ),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_events_created_idx ON ingestion_events (created_at DESC, id DESC);
CREATE INDEX ingestion_events_message_idx ON ingestion_events (message_id, created_at DESC);
