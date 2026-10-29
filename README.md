# Project Kestrel — ingestion phase

Project Kestrel is an npm-workspace modular monolith. This phase implements durable customer-message ingestion, an operational ticket API and dashboard, and a PostgreSQL-backed worker lifecycle. Classification, extraction, and LLM integration are intentionally not implemented.

## Requirements and setup

- Node.js 22+ and npm
- Docker Desktop with Docker Compose v2 for PostgreSQL and full-stack operation

Copy `.env.example` to `.env` and adjust ports or local settings as needed:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
```

Run all processes locally with `npm run dev`, or start only `npm run dev:api`, `npm run dev:worker`, or `npm run dev:dashboard`. The API and worker apply versioned migrations during startup; the worker uses bounded backoff when PostgreSQL is unavailable.

## Ingestion API

### Submit a message

`POST /api/v1/tickets` accepts only `application/json`, with this exact shape:

```json
{
  "message_id": "T-1001",
  "text": "The original customer message, preserved exactly."
}
```

Both properties must be strings and additional properties are rejected. Empty text passes the input schema but is stored as a terminal `rejected` ticket with a reason (HTTP `422`). Whitespace-only and over-limit text are handled similarly. Valid input is committed to PostgreSQL before the API responds `202 Accepted` with a `pending` ticket.

The original text is not trimmed, normalized, translated, or rewritten. The ticket table has a unique constraint on `message_id`; identical repeats return `200` with `duplicate: true` and the existing status, while a different payload for an existing ID returns `409`. Neither case changes the original ticket or its attempts. Invalid schemas return `400`; malformed JSON is `400`, unsupported media types are `415`, oversized bodies are `413`, and database errors do not yield success-shaped responses.

```powershell
$body = @{ message_id = "T-1001"; text = "My message 😀" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/tickets `
  -ContentType "application/json" -Body $body
```

### Ticket and operations endpoints

- `GET /health/live` — process liveness, independent of PostgreSQL.
- `GET /health/ready` — database readiness.
- `GET /api/v1/tickets?page=1&limit=25&status=pending` — stable, bounded ticket listing; status filter is optional.
- `GET /api/v1/tickets/:messageId` — ticket with its event history.
- `POST /api/v1/tickets/:messageId/retry` — atomically returns only `failed` tickets to `pending`; unknown IDs return `404`, other states return `409`. Full business-processing retry semantics will be added with the later processing modules.
- `GET /api/v1/ops/summary` — persisted-state counters.
- `GET /api/v1/ops/events?limit=25` — recent ingestion and worker events.

Summary definitions: `valid_tickets_received` is the current count of tickets not rejected; `pending`, `processing`, `completed`, and `failed` are ticket status counts; `rejected_tickets` counts persisted rejected tickets; `rejected_requests` counts rejected tickets plus schema-invalid requests; `duplicate_submissions`, `payload_conflicts`, and `ingestion_errors` count their respective persisted events. Duplicate requests do not increase valid-ticket counts.

## Worker behavior

The worker claims `pending` tickets transactionally with `FOR UPDATE SKIP LOCKED`, increments the attempt counter only when claiming, and sets a lease. Expired `processing` leases are recorded as recovery events, returned to `pending`, and eligible for a later claim. Rejected tickets are not eligible. The ingestion-phase worker intentionally leaves claims in `processing`; it does not mark them completed or fabricate classification/extraction output. Stop it when testing for all fixture tickets to remain pending.

## Dashboard

Open [http://localhost:5173](http://localhost:5173). The `Kestrel Ticket Desk` dashboard polls the API every five seconds and displays persisted ticket status and text, rejection/failure reasons, attempts and timestamps, recent events, operational counters, and database health. Pagination bounds each ticket request.

## Dataset runner and verification

The exact 25-message fixture is in `tests/fixtures/ingestion-messages.json`. The runner submits each message through the HTTP endpoint, then independently checks ticket uniqueness, status, and original payloads directly in PostgreSQL. It does not insert fixture tickets itself.

With a clean database, start the API but **not** the worker, then run:

```powershell
npm run dataset:submit
```

Expected first-run results: 25 submissions, 24 unique IDs, 23 accepted tickets, one rejected ticket (`T-1012`), and one duplicate submission (the second `T-1007`). There should be 24 ticket rows, no conflicting fixture payloads, and no duplicate ticket IDs. Run the same command again to verify idempotence: all 25 requests should be duplicates of already persisted tickets, with no reset of status or attempts. The runner reports actual values and fails on unexpected request errors, altered valid payloads, or duplicate ticket rows.

Useful direct SQL verification:

```sql
SELECT status, count(*) FROM tickets
WHERE message_id LIKE 'T-10%'
GROUP BY status ORDER BY status;

SELECT message_id, count(*) FROM tickets
WHERE message_id LIKE 'T-10%'
GROUP BY message_id HAVING count(*) > 1;

SELECT message_id, event_type, reason, created_at FROM ingestion_events
WHERE message_id IN ('T-1007', 'T-1012')
ORDER BY created_at, id;
```

## Tests and builds

```powershell
npm test
npm run check-types
npm run build
```

The PostgreSQL integration tests use the configured local `DATABASE_URL` (default: the Compose development database), apply migrations, and clean up only rows tagged with their unique test run ID. Start PostgreSQL before running the full suite. Schema tests do not require a database.

## Configuration

Operational settings are documented in `.env.example`: `API_PORT`, `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `MAX_REQUEST_BODY_SIZE`, `MAX_TICKET_TEXT_LENGTH`, `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_PROCESSING_LEASE_MS`, `DB_RETRY_BASE_MS`, `DB_RETRY_MAX_MS`, `DASHBOARD_ORIGIN`, and `LOG_LEVEL`. Do not commit credentials.

## Docker Compose

```powershell
npm run docker:setup
npm run docker:up
docker compose ps
```

The API and dashboard are exposed on ports 3000 and 5173 by default; PostgreSQL is exposed on 5432. The API readiness health check includes the database. Stop services without deleting persisted data with `npm run docker:down`; this retains the named PostgreSQL volume.
