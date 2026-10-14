# RelayCRM

Multi-tenant CRM with event-driven workflow automation. Design: [docs/SPECS.md](docs/SPECS.md).

**Status:** Phase 1 (foundation) in progress: auth, tenants, Postgres Row-Level Security, contacts, Docker Compose, CI.

## Run it

Everything in containers:

```bash
docker compose up --build
```

API on http://localhost:4000 (`GET /health`, routes under `/api/v1`).

Day-to-day development (Node 24.7+, pnpm 11):

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api      # http://localhost:4000
pnpm dev:web      # http://localhost:5180 (proxies /api to the API)
```

Tests (need the database running and migrated):

```bash
pnpm build && pnpm test
```

## How tenant isolation works

- The API connects as `app_user`: not a superuser, not the table owner, no `BYPASSRLS`. Migrations run as the owner.
- Every tenant table has RLS policies comparing `tenant_id` with `app.tenant_id`, which the API sets per transaction with `set_config(..., true)`. Transaction-local settings are safe behind PgBouncer in transaction mode.
- No tenant set means zero rows (fail closed). The tenant comes only from the signed JWT, never from client input.
- `apps/api/test/rls.test.ts` proves this with plain SQL as `app_user`; it runs in CI on every push.

## Layout

```
apps/api    NestJS + Prisma 7. One codebase, several entrypoints: the API now, the queue worker in Phase 3.
apps/web    Vue 3 + Vite.
infra/      Dockerfile, Postgres init script.
```
