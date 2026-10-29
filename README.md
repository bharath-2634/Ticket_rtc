Project Ticket_Rtc

Foundation for the Ticket Intelligence System, organized as an npm-workspace modular monolith. This phase contains startup checks only; it does not include ticket workflows or a database schema.

## What's Implemented

- `apps/api`: Express and TypeScript server, environment validation with Zod, Pino logging, graceful shutdown, and `GET /health/live`.
- `apps/worker`: independent Node.js/TypeScript process that logs startup and handles shutdown signals; no job-processing logic yet.
- `apps/dashboard`: React and Vite TypeScript app displaying the Project Kestrel setup placeholder.
- `packages/shared`: small package proving that workspace imports resolve across backend applications.
- PostgreSQL service using the official image, a health check, and persistent named volume. The `pg` driver is installed; no database connection code or schema exists yet.
- Vitest and Supertest API liveness smoke test, root build/type-check scripts, and Docker Compose configuration.

The repository intentionally stops at project setup: no ticket modules, migrations, LLM client, or business functionality have been added.

## Prerequisites

- Node.js 22 or later and npm
- Docker Desktop with Docker Compose v2 for the container setup

## Environment

Copy `.env.example` to `.env` and adjust local values as needed. The checked-in example contains development defaults and a placeholder LLM key; do not put real credentials in version control. The LLM settings are reserved for later phases. The Docker setup command below creates `.env` from the example if it does not already exist.

PowerShell:

```powershell
Copy-Item .env.example .env
```

## Install and Run Locally

```powershell
npm install
npm run dev
```

The API, worker, and dashboard start together. To run one at a time, use `npm run dev:api`, `npm run dev:worker`, or `npm run dev:dashboard`. PostgreSQL is not required by the setup-only API endpoint; start it with `docker compose up -d postgres` when you need the local database service.

## Verify Services

- API liveness: `http://localhost:3000/health/live` should return `{"status":"ok"}`.
- Worker: check the terminal for `Worker runtime started`.
- Dashboard: open `http://localhost:5173` and confirm it shows Project Kestrel.
- PostgreSQL: run `docker compose ps` and confirm the `postgres` service reports `healthy`.
- Foundation checks: run `npm run check-types`, `npm test`, and `npm run build`.

Ports can be changed in `.env`. The API reads `API_PORT` and `DATABASE_URL`; PostgreSQL reads its database, user, password, and port settings from the corresponding `POSTGRES_*` variables.

## Docker Setup and Run

Prerequisite: Docker Desktop must be running. Run this one-time setup command to create `.env` from the example if it is missing. An existing `.env` is left untouched:

```powershell
npm run docker:setup
```

Start the full project, building its images if needed, with one command:

```powershell
npm run docker:up
```

This runs PostgreSQL, API, worker, and the dashboard development server. Verify with `docker compose ps` (all app containers and PostgreSQL should be `healthy`), open `http://localhost:3000/health/live` and `http://localhost:5173`, and inspect worker startup with `docker compose logs worker`.

If a default host port is already in use, change `API_PORT`, `DASHBOARD_PORT`, or `POSTGRES_PORT` in `.env` to an available port and use the corresponding URL. These variables change the host-facing ports; the services continue using their internal Compose ports.

Stop containers while preserving PostgreSQL data:

```powershell
npm run docker:down
```

The named `postgres_data` volume remains. Do not use `docker compose down --volumes` if you want to keep that data. On later starts, run `npm run docker:up` again; it rebuilds images as needed.