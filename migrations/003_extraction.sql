ALTER TABLE ingestion_events
  DROP CONSTRAINT IF EXISTS ingestion_events_event_type_check;

ALTER TABLE ingestion_events
  ADD CONSTRAINT ingestion_events_event_type_check CHECK (
    event_type IN (
      'accepted', 'rejected', 'request_rejected', 'duplicate', 'payload_conflict',
      'ingestion_error', 'worker_claimed', 'worker_recovered', 'retry_requested',
      'classification_started', 'classification_succeeded', 'classification_failed',
      'classification_retry_scheduled', 'extraction_started', 'extraction_succeeded',
      'extraction_failed', 'extraction_retry_scheduled', 'ticket_completed'
    )
  );

CREATE TABLE ticket_extractions (
  ticket_id bigint PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  order_id text CHECK (order_id IS NULL OR order_id ~ '^ORD-[0-9]{5}$'),
  product text CHECK (
    product IS NULL OR product IN (
      'Aura Smart Watch', 'CloudSync Pro', 'Pulse Earbuds', 'Zen Air Purifier',
      'Nimbus Router X2', 'Vista 4K Monitor', 'Orbit Smart Speaker', 'Glide Laptop Stand'
    )
  ),
  urgency text CHECK (urgency IS NULL OR urgency IN ('Low', 'Medium', 'High')),
  requested_action text CHECK (requested_action IS NULL OR length(btrim(requested_action)) > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  llm_calls integer NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  CHECK ((status = 'completed') = (urgency IS NOT NULL)),
  CHECK (status = 'completed' OR (
    order_id IS NULL AND product IS NULL AND urgency IS NULL AND requested_action IS NULL
  ))
);

CREATE INDEX ticket_extractions_pending_idx
  ON ticket_extractions (next_attempt_at, ticket_id)
  WHERE status = 'pending';

CREATE TABLE extraction_attempts (
  id bigserial PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  call_number integer NOT NULL CHECK (call_number > 0),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  failure_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (ticket_id, call_number)
);

CREATE INDEX extraction_attempts_ticket_idx
  ON extraction_attempts (ticket_id, call_number);

INSERT INTO ticket_extractions (ticket_id, status)
SELECT ticket_id, 'pending'
FROM ticket_classifications
ON CONFLICT (ticket_id) DO NOTHING;
