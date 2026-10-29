# Initial Decisions

- **Node.js, TypeScript, and npm workspaces:** one repository and dependency lockfile keep the modular monolith straightforward to install and build while retaining clear package boundaries.
- **Express:** a small, familiar HTTP foundation with minimal setup overhead.
- **React and Vite:** a fast TypeScript-based dashboard development server and production bundler.
- **PostgreSQL and `pg`:** the selected relational database and Node.js driver; no schema or repository is introduced in this phase.
- **Zod and Pino:** runtime validation and structured logging are available to the backend without implementing domain behavior.
- **Vitest and Supertest:** a lightweight setup for unit and HTTP-level verification.
- **Separate API and worker runtimes:** these are independently deployable processes with different lifecycles, while sharing the same workspace code and backend image. Keeping them separate now avoids coupling future background work to HTTP server lifecycle.
- **Modular-monolith layout:** apps own their runtime entry points; `packages/shared` is the explicit home for cross-app contracts. This keeps future modules within one deployable system without mixing API, worker, and dashboard concerns.
- **Docker Compose:** PostgreSQL is a named-volume service with health-gated dependents. `docker compose down` preserves data; deleting it requires an explicit volume-removal command.