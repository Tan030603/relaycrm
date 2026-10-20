# RelayCRM

Multi-tenant CRM with event-driven workflow automation. Each company gets an isolated workspace for leads, deals and tasks, and builds no-code rules ("when a deal over 50,000 reaches Proposal, give the owner a review task and email them") that run reliably in the background.

TypeScript end to end: **NestJS** API + worker, **Vue 3** SPA, **Prisma 7** on **PostgreSQL 18** (Row-Level Security), **BullMQ** on Redis, Docker, GitHub Actions, Kubernetes manifests. Design: [docs/SPECS.md](docs/SPECS.md) · Decisions: [docs/adr](docs/adr) · Numbers: [docs/benchmarks.md](docs/benchmarks.md).

**[Watch the 80-second demo](demo/relaycrm-demo.mp4)**: a $120,000 deal reaches Proposal and a rule creates the review task and sends the email, visible in the run log and Mailpit.

## Run it

```bash
docker compose up --build
docker compose run --rm api node dist/src/seed.js   # demo data
```

| | |
|---|---|
| App | http://localhost:8080, sign in as `sam@northwind.example` / `relaycrm-demo` (demo data only) |
| API | http://localhost:4000 (`/api/v1/*`, `/api/v1/graphql`, `/health`, `/metrics`) |
| Worker metrics | `docker compose exec worker wget -qO- localhost:9464/metrics` |
| Mailpit | http://localhost:8025, every email the rules send lands here |

Optional: `ANTHROPIC_API_KEY=... docker compose up` turns on Claude for the deal helper and "describe a rule". Without it the deal helper uses a built-in summary.

### Development (Node 24.7+, pnpm 11)

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres redis mailpit
pnpm db:migrate && pnpm seed
pnpm dev:api       # http://localhost:4000
pnpm dev:worker    # outbox relay + queue consumers + scheduler
pnpm dev:web       # http://localhost:5180
```

Tests need Postgres, Redis and Mailpit running. They use their own database (`relaycrm_test`, see `.env.test`) and queue prefix, so a dev or Docker worker can stay up:

```bash
docker compose exec postgres createdb -U relaycrm relaycrm_test   # once
pnpm db:migrate:test
pnpm build && pnpm lint && pnpm test
```

Optional profiles:

```bash
# Prometheus :9090 (alert rules), Grafana :3300 (dashboard), Jaeger :16686 (traces)
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 docker compose --profile observability up -d
# Streaming read replica on :5441; dashboards, run log and GraphQL read from it
DATABASE_REPLICA_URL=postgresql://app_user:app_user_dev@postgres-replica:5432/relaycrm docker compose --profile replica up -d
# Redis high availability: replica + 3 Sentinels; the app follows a failover
REDIS_SENTINELS=redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379 docker compose --profile ha up -d
```

Kubernetes (any cluster with KEDA; locally a k3s container works):

```bash
kubectl apply -k infra/k8s/base             # managed Postgres/Redis, images from GHCR
kubectl apply -k infra/k8s/overlays/local   # laptop: images imported locally, DB/Redis from docker compose
```

## The 3-minute demo

1. **Today**: KPIs, my tasks, deals going quiet, live feed, 7-day automation chart.
2. **Templates → "High-value proposal" → Use template.** Open it in the rule builder, press **Test run**: each condition shows pass/fail against the latest real event; nothing is written.
3. **Pipeline**: drag a 64,000 deal into Proposal. Within a second the card gets a "Task created by rule" badge and Mailpit has the email.
4. **Run log**: the run, its two steps, idempotency key `rule:event`. A failed run shows each retry (5 s, 30 s, 5 min) and a **Retry** button that skips steps that already succeeded.
5. **Deal page**: AI summary, next step, follow-up draft.
6. **Lead forms**: copy the embed code; a submission becomes a contact and fires `lead.created`.
7. Sign in as `gina@globex.example`: an empty workspace. Isolation is enforced by Postgres, not just the API.

## Architecture

```mermaid
flowchart LR
  B[Vue SPA] -->|REST + JWT| API[API · NestJS<br/>stateless]
  API -->|one transaction:<br/>row + domain_event| PG[(PostgreSQL<br/>RLS per tenant)]
  R[Outbox relay<br/>SKIP LOCKED lease] -->|claim| PG
  R -->|jobId = event id| Q[(Redis · BullMQ)]
  Q --> W[Worker<br/>match rules → runs → actions]
  W -->|runs, steps, tasks| PG
  W --> M[SMTP / webhooks]
```

The API and the worker are the same image with two entrypoints (`dist/src/main.js`, `dist/src/worker.js`) and scale separately.

### Tenant isolation
- The app connects as `app_user`: not superuser, not owner, no `BYPASSRLS`. Every tenant table has `ENABLE` + `FORCE` RLS comparing `tenant_id` with `app.tenant_id`, set per transaction with `set_config(..., true)` (safe behind PgBouncer in transaction mode).
- No tenant set means zero rows. The tenant only ever comes from the signed JWT.
- Cross-tenant jobs (relay, retention, idle scan) run through `SECURITY DEFINER` functions owned by a `NOLOGIN` role.
- [`rls.test.ts`](apps/api/test/rls.test.ts) proves it in plain SQL, and fails if a new table with `tenant_id` forgets its policy. A forged job carrying another tenant's id does nothing ([`automation.test.ts`](apps/api/test/automation.test.ts)).

### Reliable automation (at-least-once + idempotent)
- **Outbox**: the business write and its event commit together; Redis can be down without losing anything.
- **Runs** are unique per `(tenant, rule:event)`; duplicate delivery is a no-op (tested by re-enqueuing a processed event).
- **Steps** carry `run:index` keys: `create_task` dedupes on it, `send_email` uses it as Message-ID, webhooks send it as `Idempotency-Key`. Retries skip finished steps.
- **Retries** 5 s / 30 s / 5 min, then dead-letter queue + manual retry. Non-retryable errors fail at once.
- **Guards**: chain depth ≤ 3, ≤ 20 rules per event, 10 s per action, max 5 concurrent runs per tenant (fairness), per-tenant API rate limit (Redis, shared by replicas, fails open).
- **Reaper**: every minute, runs stuck in queued/running for 5+ minutes whose queue job is gone get a fresh job (steps are idempotent, so this is safe). It recovered 26,000 runs whose jobs were lost while worker pods were being rescaled.
- **Quotas**: monthly runs per plan (`RUN_QUOTA_FREE`, ...); over-quota runs are recorded as skipped with reason `quota_exceeded`.
- **Versioning**: runs snapshot the rule and payload, so edits never rewrite history and retries work after the outbox row is purged.

### Scaling story
Pods reach Postgres through PgBouncer in transaction mode (safe because the tenant setting is transaction-local). Tenants can be placed in separate database cells (`SHARDS`, directory in the default cell; login finds the cell from the email). Run history and activities are partitioned by month (retention drops partitions instead of deleting rows); heavy read pages can use a streaming read replica. Stateless API (JWT, no sticky sessions) behind a load balancer; workers scale on queue depth (KEDA); per-process DB pools sized against `max_connections` (PgBouncer in front); every hot query uses a `tenant_id`-leading index; cursor pagination on uuidv7 ids (no `OFFSET`, no `COUNT(*)`); rules cached in Redis per tenant + trigger; retention purges old events and runs. Stages and limits: [SPECS §8](docs/SPECS.md#8-scalability-plan). Measured results: [docs/benchmarks.md](docs/benchmarks.md).

## API

REST under `/api/v1` (errors are always `{ error: { code, message, details, requestId } }`, every response has `x-request-id`, creating POSTs accept `Idempotency-Key`):

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup` `/login` `/refresh` `/logout` `/switch`, `GET /auth/me` `/workspaces` |
| Team | `GET /members`, `GET/POST /invitations`, `GET /invitations/:token`, `POST /invitations/:token/accept` |
| CRM | `GET/POST /contacts`, `GET/PATCH/DELETE /contacts/:id`, `GET /deals/board`, `GET/POST /deals`, `GET/PATCH /deals/:id`, `POST /deals/:id/move` `/activities` `/assist`, `GET/POST /tasks`, `PATCH /tasks/:id`, `GET /today` |
| Automation | `GET /automation/catalog` `/templates` `/rules` `/rules/:id`, `POST /automation/rules` `/rules/test` `/rules/generate` `/rules/:id/test` `/rules/:id/enable` `/rules/:id/disable` `/templates/:key/install`, `PATCH /automation/rules/:id`, `GET /automation/runs` `/runs/:id`, `POST /automation/runs/:id/retry` |
| Lead forms | `GET/POST /forms`, `PATCH /forms/:id`; public `GET/POST /public/forms/:tenantId/:formId` |
| GraphQL | `POST /graphql`: read-only run history (`runs`, `run`, lazy `steps`) |

Refresh tokens are httpOnly `SameSite=Strict` cookies, rotated on every use; reusing an old one revokes the whole chain.

## Observability
- JSON logs (pino) with `request_id`, `tenant_id`, `run_id`, `event_id`; emails and phone numbers are redacted.
- Prometheus: API latency histogram by route (`/metrics`); worker queue depth, oldest-job age, run outcomes, relayed events (`:9464/metrics`).
- OpenTelemetry traces (on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set): the W3C `traceparent` of the request is stored with the outbox event and continued by the relay, the event job, the run and each action, so one trace shows request → event → queue → worker → action. HTTP, Express, pg and ioredis are auto-instrumented.
- Grafana dashboard provisioned from [`infra/grafana`](infra/grafana): request rate, latency percentiles, queue depth, oldest job age, run outcomes, relay throughput, 5xx ratio, event-loop lag.
- Alert rules from the spec (queue backlog > 60 s, DLQ growing, 5xx > 2%, p95 > 300 ms) in [`infra/prometheus`](infra/prometheus); `docker compose --profile observability up` adds Prometheus on :9090.
- The run log UI is the user-facing trace: why a rule fired, what each step did, why it failed.

## Layout

```
apps/api            NestJS + Prisma. API entrypoint (src/main.ts) and worker entrypoint (src/worker.ts)
  src/automation    engine.ts (pure rule logic), actions.ts (one handler per action), controller
  prisma/           schema + migrations (RLS policies and SQL functions are hand-written in them)
  test/             unit, RLS isolation, API, automation end to end
apps/web            Vue 3 + Vite SPA
infra/docker        Dockerfiles (non-root), nginx, Postgres init
infra/k8s           Kustomize base (API HPA + PDB, worker KEDA on queue depth, PgBouncer, web, migrate Job) + local overlay
scripts/k6          load scenarios: steady, noisy neighbour, burst
docs/               SPECS, ADRs, benchmarks
```
