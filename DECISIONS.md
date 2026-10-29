# Initial Decisions

- **Node.js, TypeScript, and npm workspaces:** one repository and dependency lockfile keep the modular monolith straightforward to install and build while retaining clear package boundaries.
- **Express:** a small, familiar HTTP foundation with minimal setup overhead.
- **React and Vite:** a fast TypeScript-based dashboard development server and production bundler.
- **PostgreSQL and `pg`:** PostgreSQL is the durable source of truth. A unique message-ID constraint and atomic `INSERT ... ON CONFLICT DO NOTHING` prevent concurrent duplicate tickets.
- **Zod and Pino:** Zod enforces the two-string request contract; Pino logs server-side failures without exposing internal details to API clients.
- **Vitest and Supertest:** a lightweight setup for unit and HTTP-level verification.
- **Separate API and worker runtimes:** these are independently deployable processes with different lifecycles, while sharing the same workspace code and backend image. Keeping them separate now avoids coupling future background work to HTTP server lifecycle.
- **Modular-monolith layout:** apps own their runtime entry points; `packages/shared` is the explicit home for cross-app contracts. This keeps future modules within one deployable system without mixing API, worker, and dashboard concerns.
- **Docker Compose:** PostgreSQL is a named-volume service with health-gated dependents. `docker compose down` preserves data; deleting it requires an explicit volume-removal command.
- **Tickets and ingestion events are separate tables:** ticket identity and status remain stable while rejection, duplicate, conflict, and worker-recovery history remains observable.
- **Worker leases and `SKIP LOCKED`:** claims are transactional and concurrent-safe; expired leases are recovered. This phase intentionally does not mark processing completed because no business processor exists yet.
- **Dashboard polling:** bounded API polling every five seconds avoids unnecessary SSE infrastructure; all displayed state comes from PostgreSQL-backed API endpoints.
- **LLM integration:** use the supplied OpenAI-compatible chat-completions API and model through environment configuration. A strict JSON/Zod contract rejects malformed, explanatory, or unknown category results rather than guessing.
- **Durable classification checkpoint:** `ticket_classifications` and `classification_attempts` separate durable stage completion from overall ticket completion. The category and stage state commit together, so successful classification is reused after restart.
- **Three-failure classification retry:** failed calls are recorded individually with exponential backoff; the ticket fails after three attempts per retry cycle. Operator retry resets the cycle count while preserving the total LLM-call ledger.
- **Durable extraction checkpoint:** `ticket_extractions` and `extraction_attempts` preserve structured extraction separately from classification. A ticket becomes completed only after both stages succeed; an extraction retry does not repeat classification. Product and order identifiers are validated against the catalogue and original message before persistence.
- **Database-backed results export:** `results.json` is generated from persisted tickets, never from transient worker state, and is replaced atomically to avoid partial output.