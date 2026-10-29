ALTER TABLE tickets ADD COLUMN lease_token uuid;

ALTER TABLE ingestion_events
  DROP CONSTRAINT IF EXISTS ingestion_events_event_type_check;

ALTER TABLE ingestion_events
  ADD CONSTRAINT ingestion_events_event_type_check CHECK (
    event_type IN (
      'accepted', 'rejected', 'request_rejected', 'duplicate', 'payload_conflict',
      'ingestion_error', 'worker_claimed', 'worker_recovered', 'retry_requested',
      'classification_started', 'classification_succeeded', 'classification_failed',
      'classification_retry_scheduled'
    )
  );

CREATE TABLE ticket_classifications (
  ticket_id bigint PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  category text CHECK (
    category IS NULL OR category IN ('Billing', 'Technical issue', 'Account access', 'Refund', 'Other')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  llm_calls integer NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  CHECK ((status = 'completed') = (category IS NOT NULL))
);

CREATE INDEX ticket_classifications_pending_idx
  ON ticket_classifications (next_attempt_at, ticket_id)
  WHERE status = 'pending';

CREATE TABLE classification_attempts (
  id bigserial PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  call_number integer NOT NULL CHECK (call_number > 0),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  category text CHECK (
    category IS NULL OR category IN ('Billing', 'Technical issue', 'Account access', 'Refund', 'Other')
  ),
  failure_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (ticket_id, call_number),
  CHECK ((status = 'succeeded') = (category IS NOT NULL))
);

CREATE INDEX classification_attempts_ticket_idx
  ON classification_attempts (ticket_id, call_number);

INSERT INTO ticket_classifications (ticket_id, status, last_error)
SELECT id,
       CASE WHEN status = 'failed' THEN 'failed' ELSE 'pending' END,
       CASE WHEN status = 'failed' THEN COALESCE(last_error, 'Ticket failed before classification was introduced') END
FROM tickets
WHERE status IN ('pending', 'processing', 'failed');

UPDATE tickets
SET status = 'pending', processing_started_at = NULL, lease_expires_at = NULL
WHERE status = 'processing' AND lease_expires_at IS NULL;
