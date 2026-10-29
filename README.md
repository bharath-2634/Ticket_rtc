# Project Kestrel — ticket processing pipeline

Project Kestrel is an npm-workspace modular monolith. It implements durable customer-message ingestion, LLM-based ticket classification and structured extraction, PostgreSQL checkpoints, and a database-backed results export.

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

Run all processes locally with `npm run dev`, or start only `npm run dev:api`, `npm run dev:worker`, or `npm run dev:dashboard`. The API and worker apply versioned migrations during startup; the worker uses bounded backoff when PostgreSQL is unavailable. Before starting the worker, verify `LLM_BASE_URL` and `LLM_MODEL` in `.env`; `.env.example` contains the supplied ngrok endpoint and `qwen3-4b` model as defaults.

## Ingestion API

### Submit a message

`POST /api/v1/tickets` accepts only `application/json`, with this exact shape:

```json
{
  "message_id": "T-1001",
  "text": "The original customer message, preserved exactly."
}
```

Both properties must be strings and additional properties are rejected. Empty text passes the input schema but is stored as a terminal `rejected` ticket with a reason (HTTP `422`). Whitespace-only and over-limit text are handled similarly. Ticket text may contain at most 24,000 Unicode code points (inclusive); surrogate-pair characters such as most emoji count as one code point. The effective limit is fixed in API configuration at 24,000, so a stale `MAX_TICKET_TEXT_LENGTH` environment override is ignored with a startup warning. The setting shown in `.env.example` documents the fixed limit. Valid input is committed to PostgreSQL before the API responds `202 Accepted` with a `pending` ticket.

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

Classification and extraction counters are persisted-state aggregates. `classification_pending`, `classification_in_progress`, `classification_completed`, and `classification_failed` and their `extraction_*` equivalents count checkpoint states. The corresponding `*_calls` count recorded outbound LLM attempts; `*_successes` and `*_call_failures` count successful and failed responses; `*_retries` count calls after the first for each ticket. `llm_configured` indicates that the API process has an endpoint and model configured; it is not a live health probe.

## Worker behavior

The worker claims `pending` tickets transactionally with `FOR UPDATE SKIP LOCKED`, increments ticket processing attempts on claim, and sets a renewable lease. It calls the configured OpenAI-compatible `POST {LLM_BASE_URL}/v1/chat/completions` endpoint using the configured model and the `ngrok-skip-browser-warning` header. The API key is optional and is sent only when configured as a Bearer token. The system prompt asks for exactly `{"category":"..."}` using `Billing`, `Technical issue`, `Account access`, `Refund`, or `Other`; the response must be valid JSON with exactly one field and an allowed category.

Each outbound LLM call and its state is recorded in `classification_attempts`. A separate `ticket_classifications` row stores the durable checkpoint. Successful results are committed transactionally before a ticket leaves the leased worker stage; an already-completed checkpoint is never called again. Database write failures after a valid LLM response are retried without another model request. The worker does not claim exactly-once calls across a crash between the remote response and local commit.

The default maximum is three failed classification calls per retry cycle. Failed calls are persisted, with exponential backoff; after the third, the ticket and classification stage become `failed`. The existing operator retry endpoint resets only the current classification retry-cycle count, retains cumulative LLM call history, and requeues the same ticket. Ticket `attempts` counts worker claims; checkpoint `attempts` counts calls in the current retry cycle; `llm_calls` and the attempt ledger are cumulative. A successful classification leaves the ticket `processing` while the worker proceeds to extraction. Extraction uses the same configured OpenAI-compatible endpoint and model, with the saved category and original message as context. It requires exactly four JSON fields: `order_id`, `product`, `urgency`, and `requested_action`. Missing/unsupported values must be `null` (urgency is always `Low`, `Medium`, or `High`); order IDs are checked against the original text and products normalize only against the documented catalogue/aliases. Extraction results are persisted as a separate checkpoint; the ticket is marked `completed` only after extraction succeeds. Classification checkpoints are not repeated when extraction fails. Expired leases recover unfinished stages; rejected tickets receive neither checkpoint.

Each stage records attempts and applies bounded exponential backoff; the default maximum is three failed calls per retry cycle. Operator retries restart only the failed stage's retry-cycle count and preserve the cumulative call ledger. Relevant settings: `LLM_BASE_URL`, `LLM_MODEL`, optional `LLM_API_KEY`, `LLM_TIMEOUT_MS`, `CLASSIFICATION_MAX_ATTEMPTS`, `CLASSIFICATION_RETRY_BASE_MS`, `CLASSIFICATION_RETRY_MAX_MS`, `EXTRACTION_MAX_ATTEMPTS`, `EXTRACTION_RETRY_BASE_MS`, and `EXTRACTION_RETRY_MAX_MS`. `LLM_BASE_URL` is the server base URL, with or without a trailing `/v1`.

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

To test the configured LLM independently without submitting a customer ticket:

```powershell
npm run llm:smoke
```

For a complete local dataset run, start PostgreSQL, apply migrations (API and worker also migrate during startup), and start the API and worker with the `.env` model endpoint configured. Then run:

```powershell
npm run dataset:classify
```

The runner submits the fixture through HTTP, waits for terminal ticket states, verifies the expected accepted/rejected/duplicate counts and stage completion, then writes `results.json` from PostgreSQL. The export contains exactly `message_id`, `status`, `category`, `order_id`, `product`, `urgency`, and `requested_action`; it uses an atomic temporary-file replacement. To export persisted state separately, run `npm run results:export -- .\results.json`. The LLM call costs/timeouts are controlled by the endpoint and `LLM_TIMEOUT_MS`. The PostgreSQL integration suite uses a deterministic local HTTP mock and exercises the same client and worker flow without sending fixture text to the live model.

## Configuration

Operational settings are documented in `.env.example`: `API_PORT`, `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `MAX_REQUEST_BODY_SIZE`, `MAX_TICKET_TEXT_LENGTH` (fixed at 24,000; environment overrides are ignored), `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_PROCESSING_LEASE_MS`, `DB_RETRY_BASE_MS`, `DB_RETRY_MAX_MS`, `DASHBOARD_ORIGIN`, and `LOG_LEVEL`. Do not commit credentials.

## Docker Compose

```powershell
npm run docker:setup
npm run docker:up
docker compose ps
```

The API and dashboard are exposed on ports 3000 and 5173 by default; PostgreSQL is exposed on 5432. The API readiness health check includes the database. Stop services without deleting persisted data with `npm run docker:down`; this retains the named PostgreSQL volume.
