# RelayCRM — Multi-Tenant CRM with Event-Driven Workflow Automation

> Working title. Status: **Draft v0.1** (design before demo build)
> Stack: TypeScript everywhere. NestJS (API + worker), Vue 3 (SPA), Prisma, PostgreSQL, Redis + BullMQ, Docker, GitHub Actions (Kubernetes after demo)

---

## 1. Overview

RelayCRM is a multi-tenant SaaS CRM. Each company (tenant) gets an isolated workspace to manage leads, deals and tasks, and can build **no-code automation rules** (trigger → conditions → actions) that run reliably in the background.

### 1.1 Goals

1. **Strict tenant isolation**: one tenant can never read or write another tenant's data, enforced at the database level, not only in application code.
2. **Reliable automation**: every business event that should fire a rule does so **at least once**, and actions are **idempotent**, so effectively exactly once.
3. **Horizontal scalability**: API and workers scale out independently; no single tenant can starve the others.
4. **Observable**: every automation run is traceable (why it fired, what it did, why it failed).
5. **Demo-able**: whole system starts with `docker compose up` and tells its story in 3–5 minutes.

### 1.2 Non-goals (for v1 demo)

Billing/plans, WhatsApp, CSV import, dashboards/reports, public API, AI features, visual drag-and-drop flow canvas, multi-region, Kubernetes manifests (added after demo works).

---

## 2. Scope

### 2.1 Demo (MVP) scope

| Area | Included |
|---|---|
| Auth & tenancy | Sign up creates tenant + owner; invite user; roles: `owner`, `rep` |
| CRM | Leads/contacts, deals (Kanban, 5 stages), tasks |
| Automation | Triggers: `lead.created`, `deal.stage_changed`. Conditions: simple field comparisons. Actions: `create_task`, `send_email` |
| Rule builder | Form-based (dropdowns), enable/disable, test run |
| Execution log | Per-run status, steps, errors, retry count |
| Ops | Docker Compose, GitHub Actions (lint, test, build) |

### 2.2 Phase 2 (after demo)

Time-based triggers (idle lead), webhook action, WhatsApp action, audit log, dashboards, public API, plans & quotas, Kubernetes + autoscaling, AI summaries.

---

## 3. Architecture

### 3.1 High-level diagram

```
 Browser (Vue 3 SPA)
        │  HTTPS
        ▼
 ┌──────────────┐        ┌────────────────────┐
 │  API (Node)  │──────▶ │ PostgreSQL         │
 │  stateless   │  RLS   │ - business tables  │
 └──────┬───────┘        │ - domain_events    │ (outbox)
        │                │ - automation_runs  │
        │                └─────────▲──────────┘
        │                          │
        │          ┌───────────────┴──────────────┐
        │          │  Outbox Relay (poller)       │
        │          │  reads unpublished events    │
        │          └───────────────┬──────────────┘
        │                          ▼
        │                 ┌──────────────────┐
        └───rate limit──▶ │ Redis            │
                          │ - BullMQ queues  │
                          │ - rate limiters  │
                          │ - cache          │
                          └────────┬─────────┘
                                   ▼
                     ┌───────────────────────────┐
                     │ Worker pool (Node)        │
                     │ 1. match rules            │
                     │ 2. evaluate conditions    │
                     │ 3. execute actions        │
                     └───────────┬───────────────┘
                                 ▼
                      SMTP (Mailpit in dev) / webhooks
```

### 3.2 Components

| Component | Responsibility | Scaling |
|---|---|---|
| **API** | REST, auth, CRUD, writes business row + outbox event **in one transaction** | Stateless, scale by replicas |
| **Outbox relay** | Moves committed events from `domain_events` to the queue | 1–N instances using `FOR UPDATE SKIP LOCKED` |
| **Worker** | Consumes events, matches rules, runs actions | Scale by queue depth |
| **Scheduler** (phase 2) | Emits time-based events (idle lead, reminders) | Single leader with lock |
| **PostgreSQL** | Source of truth, RLS isolation | Vertical first, then read replica, partitioning |
| **Redis** | Queues, rate limiting, short-lived cache | Single node → Sentinel/Cluster later |

### 3.3 Monolith first, split later

Start as a **modular monolith** (one repo, one codebase, two entrypoints: `api` and `worker`). The same image runs in two modes. This keeps development fast while letting API and workers scale independently. Extract services only if a real bottleneck appears.

---

## 4. Multi-Tenancy Design

### 4.1 Model

**Shared database, shared schema, `tenant_id` on every tenant-owned table**, enforced by PostgreSQL Row-Level Security (RLS).

Rationale: cheapest to operate, easiest to migrate, scales to thousands of small tenants. Trade-off: noisy neighbours and weaker physical isolation; mitigated in section 8.

### 4.2 Enforcement

1. Application connects as a **non-superuser, non-owner role** (`app_user`). Superusers and table owners bypass RLS, so this is mandatory.
2. Each request/job starts a transaction and sets the tenant:
   ```sql
   BEGIN;
   SELECT set_config('app.tenant_id', '<uuid>', true);  -- true = local to transaction
   -- ... queries ...
   COMMIT;
   ```
3. Every tenant table has:
   ```sql
   ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
   ALTER TABLE leads FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON leads
     USING (tenant_id = current_setting('app.tenant_id')::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
   ```
4. A request with no tenant set must **fail closed** (query returns nothing / errors), never return all rows.
5. Using `set_config(..., true)` (transaction-local) keeps this safe with PgBouncer in **transaction pooling** mode.

### 4.3 Tenant context propagation

- API: tenant resolved from the JWT (`tid` claim), never from a client-supplied header or body.
- Events/jobs: every event and job payload carries `tenant_id`; the worker sets the RLS context before touching the database.
- Logs and metrics: tagged with `tenant_id`.

### 4.4 Isolation tests (must exist in CI)

- Tenant A cannot `SELECT`, `UPDATE`, `DELETE` Tenant B rows (direct SQL via `app_user`).
- Inserting a row with another tenant's `tenant_id` is rejected by `WITH CHECK`.
- Missing tenant context returns zero rows.
- A job for Tenant A cannot trigger an action on Tenant B.

---

## 5. Data Model

All tables have `id uuid pk`, `tenant_id uuid not null`, `created_at`, `updated_at` unless noted. Composite indexes always **start with `tenant_id`**.

### 5.1 Identity

```
tenants        (id, name, slug unique, plan, status)
users          (id, email unique, password_hash, name)          -- global, no tenant_id
memberships    (id, tenant_id, user_id, role)                    -- unique (tenant_id, user_id)
invitations    (id, tenant_id, email, role, token_hash, expires_at, accepted_at)
```

> A user can belong to several tenants later; `memberships` supports this from day one.

### 5.2 CRM

```
contacts   (id, tenant_id, name, email, phone, company, source, owner_id, tags text[])
deals      (id, tenant_id, contact_id, title, value numeric, currency, stage, owner_id,
            expected_close_date, stage_changed_at)
tasks      (id, tenant_id, title, due_at, assignee_id, status, deal_id, contact_id,
            created_by_rule_id null)
activities (id, tenant_id, type, contact_id, deal_id, note, occurred_at, actor_id)
```

Indexes (examples): `(tenant_id, stage)`, `(tenant_id, owner_id)`, `(tenant_id, stage_changed_at)`, `(tenant_id, email)`.

### 5.3 Automation

```
automation_rules (
  id, tenant_id, name, enabled bool, version int,
  trigger_type text,          -- 'lead.created' | 'deal.stage_changed'
  conditions jsonb,           -- see 6.2
  actions jsonb,              -- see 6.3
  created_by, updated_by
)

domain_events (                -- transactional outbox
  id, tenant_id, type text, aggregate_type, aggregate_id,
  payload jsonb, occurred_at,
  published_at null,           -- null = not yet sent to queue
  attempts int default 0
)

automation_runs (
  id, tenant_id, rule_id, rule_version,
  event_id,                    -- which event triggered it
  idempotency_key text,        -- unique: rule_id + event_id
  status text,                 -- 'queued'|'running'|'succeeded'|'failed'|'skipped'
  skip_reason null,            -- e.g. 'conditions_not_met'
  started_at, finished_at, attempt int, depth int, error text null
)  -- UNIQUE (tenant_id, idempotency_key); partitioned by month on created_at

automation_run_steps (
  id, tenant_id, run_id, action_index, action_type,
  status, input jsonb, output jsonb, error null, started_at, finished_at
)
```

### 5.4 Retention

- `domain_events`: delete published rows older than 7 days.
- `automation_runs` / `steps`: keep 90 days by default; partitions dropped by month (cheap, no mass `DELETE`).

---

## 6. Automation Engine

### 6.1 Execution flow

```
1. API handler (single DB transaction):
      UPDATE deals SET stage = 'proposal' ...
      INSERT INTO domain_events (type='deal.stage_changed', payload=...)
   COMMIT                                   ← business change and event are atomic

2. Outbox relay (loop):
      SELECT ... FROM domain_events
      WHERE published_at IS NULL
      ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED
      → add to BullMQ queue 'events' (jobId = event.id)  ← dedupes at queue level
      → UPDATE published_at = now()

3. Worker 'events' job:
      a. Load enabled rules for (tenant_id, trigger_type)   (cached, short TTL)
      b. For each rule: evaluate conditions against payload
      c. If match: INSERT automation_runs (idempotency_key = rule_id:event_id)
           ON CONFLICT DO NOTHING   ← duplicate delivery is a no-op
      d. Enqueue 'actions' job per run

4. Worker 'actions' job:
      For each action in order:
        - write step row (running)
        - execute with timeout
        - write step result
      Mark run succeeded / failed. Retry with backoff on transient errors.
```

### 6.2 Rule schema (conditions)

```json
{
  "all": [
    { "field": "deal.value", "op": "gt", "value": 50000 },
    { "field": "deal.stage", "op": "eq", "value": "proposal" }
  ]
}
```

- Supported combinators: `all` (AND), `any` (OR). Nesting allowed up to depth 3.
- Operators v1: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`.
- Fields are validated against a **whitelist per trigger type**. No arbitrary expressions, no `eval`.

### 6.3 Actions schema

```json
[
  { "type": "create_task",
    "params": { "title": "Review {{deal.title}}", "assignee": "role:owner", "due_in_hours": 24 } },
  { "type": "send_email",
    "params": { "to": "{{deal.owner.email}}", "template": "high_value_deal" } }
]
```

- Templating: simple `{{path}}` substitution with a **whitelisted variable context**, no code execution.
- Action handlers implement one interface:
  ```ts
  interface ActionHandler<P> {
    type: string;
    validate(params: unknown): P;
    execute(ctx: RunContext, params: P): Promise<ActionResult>;
  }
  ```
  Adding an action = adding one handler file.

### 6.4 Delivery semantics

| Concern | Decision |
|---|---|
| Delivery | **At-least-once** (outbox + queue retries) |
| Duplicates | Prevented by `UNIQUE(tenant_id, idempotency_key)` on runs and by deterministic job IDs |
| Action idempotency | Each step has an idempotency key (`run_id:action_index`); `create_task` checks it, `send_email` passes it as a message ID |
| Ordering | Not guaranteed globally; guaranteed per aggregate if needed by using the `aggregate_id` as a queue group key (phase 2) |
| Retries | Exponential backoff (e.g. 5s, 30s, 5m), max 3 attempts for transient errors; non-retryable errors (validation, 4xx) fail immediately |
| Dead letters | After max attempts, run is `failed` and job moves to a `dlq` queue; visible in UI with a manual "retry" button |

### 6.5 Safety guards

- **Loop prevention**: events created by an automation carry `depth`; reject when `depth > 3` so rule A → rule B → rule A cannot run forever.
- **Per-run timeout**: each action has a timeout (e.g. 10s); each run has a total cap.
- **Per-tenant fan-out limit**: one event may match at most N rules (e.g. 20).
- **Rule versioning**: runs record `rule_version`, so editing a rule never rewrites history.
- **Dry run / test mode**: evaluate conditions and show the planned actions against a sample event without side effects.

---

## 7. API Design (REST, JSON)

Base: `/api/v1`. Auth: short-lived JWT access token + refresh token (httpOnly cookie). Cursor pagination on all list endpoints.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Team | `GET /members`, `POST /invitations`, `POST /invitations/:token/accept` |
| Contacts | `GET/POST /contacts`, `GET/PATCH/DELETE /contacts/:id` |
| Deals | `GET/POST /deals`, `PATCH /deals/:id`, `POST /deals/:id/move` |
| Tasks | `GET/POST /tasks`, `PATCH /tasks/:id` |
| Rules | `GET/POST /automation/rules`, `PATCH /rules/:id`, `POST /rules/:id/test`, `POST /rules/:id/enable|disable` |
| Runs | `GET /automation/runs`, `GET /automation/runs/:id`, `POST /automation/runs/:id/retry` |

Conventions: consistent error shape `{ error: { code, message, details } }`, request IDs on every response, `Idempotency-Key` header supported on `POST` that creates resources.

---

## 8. Scalability Plan

### 8.1 Design targets (assumptions, to be validated by load tests)

| Metric | Demo target | Growth target |
|---|---|---|
| Tenants | 100 | 5,000 |
| Users per tenant | 20 | 200 |
| Contacts total | 1 M | 50 M |
| Domain events | 50 / s sustained, 200 / s burst | 1,000 / s |
| API latency (reads) | p95 < 200 ms | p95 < 300 ms |
| Event → first action start | p95 < 5 s | p95 < 10 s |
| Availability | best effort | 99.9% |

These are design targets, not measured results. Section 12 defines how to measure them.

### 8.2 Likely bottlenecks, in order

1. **PostgreSQL writes and connections** (events, runs, run steps are write-heavy).
2. **Noisy tenant** flooding the queue and delaying others.
3. **Rule lookup per event** (hot read).
4. **Large tables** (`automation_runs`, `activities`) growing without bound.
5. **Redis memory / single node**.
6. **External actions** (SMTP, webhooks) being slow and blocking workers.

### 8.3 Scaling stages

**Stage 0: Demo (single node, Docker Compose)**
1 API, 1 worker, 1 Postgres, 1 Redis. Correctness first.

**Stage 1: Scale out the stateless parts**
- API replicas behind a load balancer (stateless JWT, no sticky sessions).
- N workers; concurrency per worker tuned (start 10 jobs).
- **PgBouncer** in transaction mode in front of Postgres.
- Connection budget: `(api_replicas × pool) + (worker_replicas × pool) < max_connections`.

**Stage 2: Protect the database**
- Right indexes, `tenant_id`-leading; `EXPLAIN ANALYZE` on every hot query.
- Cache enabled rules per `(tenant_id, trigger_type)` in Redis (TTL 30–60s, invalidated on rule change via pub/sub).
- Batch writes for run steps where possible.
- Monthly **partitioning** for `automation_runs`, `automation_run_steps`, `activities`.
- **Read replica** for dashboards, run-history and list endpoints.

**Stage 3: Fairness and isolation between tenants**
- **Per-tenant rate limits** on the API (token bucket in Redis, e.g. 100 req/s per tenant).
- **Per-tenant concurrency cap** in workers (e.g. max 5 concurrent runs per tenant).
- **Sharded or weighted queues**: separate queues for `critical` (user-facing) and `bulk`; optionally hash tenants into K queue shards so one tenant only blocks its shard.
- **Quotas**: runs per month per plan; over-quota runs are `skipped` with a visible reason instead of silently dropped.
- **Per-tenant statement timeouts** and query limits for expensive endpoints.

**Stage 4: Kubernetes autoscaling**
- API: HPA on CPU and request rate.
- Workers: **KEDA** scaling on BullMQ queue depth / oldest job age.
- Separate worker deployments per queue (`events`, `actions`, `webhooks`) so slow external calls never starve internal processing.
- PodDisruptionBudgets and graceful shutdown (finish in-flight jobs on SIGTERM).

**Stage 5: Beyond a single Postgres**
- Move large append-only data (run history) to a separate store or database.
- **Tenant sharding**: map `tenant_id → shard` in a directory table; large tenants get a dedicated database ("cell").
- Redis Sentinel or Cluster; separate Redis for queues vs cache.

### 8.4 Hot paths and decisions

| Path | Decision |
|---|---|
| Rule lookup | Cache per tenant+trigger; fall back to DB on miss |
| Event publishing | Outbox poller with `SKIP LOCKED`; batch size 100; poll 200 ms (later: `LISTEN/NOTIFY` to wake it) |
| Kanban board | Cursor pagination per stage, only needed columns, no `COUNT(*)` on large sets |
| List/search | Index-backed filters only in v1; full-text search later (Postgres `tsvector`, then OpenSearch if needed) |
| Run history UI | Always filter by time window (hits one partition) |

### 8.5 Failure and backpressure

- **Redis down**: API still works (events accumulate in `domain_events`); relay resumes when Redis returns. No data loss because the outbox is in Postgres.
- **Worker crash mid-job**: BullMQ stalled-job recovery re-queues it; idempotency keys prevent duplicate effects.
- **Slow SMTP/webhook**: per-action timeout, circuit breaker per destination, retry with backoff.
- **Queue backlog**: alert on oldest-job age; autoscale workers; shed `bulk` load first.
- **Poison message**: capped attempts then DLQ, never an infinite retry loop.

---

## 9. Security

- Passwords hashed with Argon2id; rate-limited login; refresh token rotation.
- JWT contains `sub`, `tid`, `role`; roles checked in API middleware **and** tenant isolation checked by RLS (defence in depth).
- Role matrix: `owner` (everything incl. members), `rep` (own deals/tasks, read contacts; cannot edit rules in v1).
- Input validation on all endpoints (Zod); parameterised queries only.
- Rule templates are logic-less; no user-supplied code execution anywhere.
- Webhook/SSRF protection (phase 2): block private IP ranges, enforce HTTPS, sign payloads (HMAC).
- Secrets in environment / secret manager, never in the repo.
- PII: encrypt at rest (disk level), TLS in transit; log scrubbing for emails and phone numbers.
- Dependency scanning in CI (npm audit / Dependabot).

---

## 10. Observability

| Signal | Tooling | Key items |
|---|---|---|
| Logs | Structured JSON (pino) | `request_id`, `tenant_id`, `run_id`, `event_id` on every line |
| Metrics | Prometheus + Grafana | request latency/error rate, queue depth, oldest-job age, run success rate, retries, DLQ size, DB pool usage |
| Traces | OpenTelemetry | API request → event → queue → worker → action (one trace) |
| Alerts | Grafana / Alertmanager | oldest job age > 60 s, DLQ growing, error rate > 2%, DB connections > 80% |

User-facing observability: the **execution log UI** is a product feature, not just an ops tool.

---

## 11. Deployment & CI/CD

### 11.1 Environments

- **Local/demo**: `docker compose up` (api, worker, relay, postgres, redis, mailpit, web).
- **Staging/prod** (phase 2): Kubernetes, managed Postgres and Redis.

### 11.2 GitHub Actions pipeline

1. Install, lint, typecheck
2. Unit tests
3. Integration tests (Postgres + Redis service containers), including **RLS isolation tests**
4. Build Docker image (multi-stage, non-root user)
5. Push image on `main` (tagged with commit SHA)
6. (Phase 2) Deploy to staging, run smoke test

### 11.3 Migrations

- Prisma Migrate. RLS policies and partitions are written as raw SQL inside the generated migration files.
- Tenant context: every query runs inside a Prisma interactive transaction (via a client extension) that first calls `set_config('app.tenant_id', ..., true)`.
- Expand/contract pattern for zero-downtime changes (add nullable → backfill → enforce → drop old).

---

## 12. Testing & Load Plan

### 12.1 Test types

| Type | What |
|---|---|
| Unit | condition evaluator, template rendering, action validators |
| Integration | API + DB + queue end to end; **tenant isolation suite** |
| Reliability | kill worker mid-run, kill Redis, fail SMTP; assert no lost or duplicate effects |
| Load | k6 scripts for API, plus an event generator for the automation path |

### 12.2 Load scenarios (k6)

1. **Steady**: 100 tenants, mixed CRUD, 50 events/s for 30 min. Measure p95 latency and event → action delay.
2. **Noisy neighbour**: one tenant sends 10× the load; verify other tenants' p95 stays within target.
3. **Burst**: 1,000 events in 10 s; verify backlog drains and nothing is dropped.
4. **Failure injection**: SMTP down for 5 min; verify retries, DLQ behaviour and recovery.

Record results in `docs/benchmarks.md` with hardware, dataset size and charts. Real numbers make the README far more convincing than claims.

---

## 13. Repository Layout

```
relaycrm/
├─ apps/
│  ├─ api/            # HTTP server entrypoint
│  ├─ worker/         # queue consumers + outbox relay entrypoint
│  └─ web/            # Vue 3 SPA
├─ packages/
│  ├─ core/           # domain logic (deals, rules engine), no framework deps
│  ├─ db/             # migrations, RLS policies, tenant-aware client
│  ├─ queue/          # BullMQ setup, job types
│  └─ shared/         # types, zod schemas, constants
├─ infra/
│  ├─ docker/         # Dockerfiles, compose files
│  └─ k8s/            # manifests/Helm (phase 2)
├─ docs/
│  ├─ SPECS.md
│  ├─ adr/            # architecture decision records
│  └─ benchmarks.md
├─ scripts/           # seed data, demo script, load tests (k6)
└─ .github/workflows/
```

---

## 14. Roadmap

| Week | Deliverable | Done when |
|---|---|---|
| 1 | Auth, tenants, memberships, RLS, Docker Compose, CI skeleton | Isolation tests pass in CI |
| 2 | Contacts, deals, Kanban, tasks | Basic CRM usable in UI |
| 3 | Outbox, relay, queue, worker; `deal.stage_changed` → `create_task` end to end | Event fires task, with idempotency test |
| 4 | Rule builder UI, conditions, `send_email`, execution log, retries, DLQ | Demo script runs fully |
| 5 | Seed data, k6 baseline, README, architecture diagram, demo video | Benchmarks documented |
| 6+ | Time-based triggers, Kubernetes + KEDA, quotas, audit log | Phase 2 backlog |

---

## 15. Key Decisions (ADR candidates)

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Shared schema + RLS | Schema-per-tenant, DB-per-tenant | Lowest ops cost; scales to many small tenants; shard later |
| 2 | Transactional outbox | Publish to queue directly from the API | Avoids lost or phantom events when DB commit and queue publish disagree |
| 3 | BullMQ on Redis | Kafka, RabbitMQ, SQS | Simple, good Node support, enough for target scale |
| 4 | Whitelisted JSON rules, no scripting | Embedded JS/expressions | Security and predictability |
| 5 | Modular monolith, two entrypoints | Microservices | Speed of development; independent scaling still possible |
| 6 | At-least-once + idempotency | Exactly-once claims | Exactly-once is not achievable end to end; idempotency gives the same outcome |

---

## 16. Open Questions

1. ~~Frontend framework~~ **Decided: Vue 3 + TypeScript.**
2. ~~ORM/query layer~~ **Decided: Prisma** (raw SQL migrations for RLS; transaction wrapper sets tenant context).
3. ~~API framework~~ **Decided: NestJS** (same codebase serves the `api` and `worker` entrypoints).
4. Should reps be able to create their own rules, or owners only (v1 assumes owners only)?
5. Which email provider for non-dev environments (Resend, SES, SMTP relay)?
6. Is a free tier with hard quotas needed for the live demo deployment?

---

## 17. Glossary

- **Tenant**: one customer company and its isolated data.
- **RLS**: PostgreSQL Row-Level Security, per-row access policies enforced by the database.
- **Outbox pattern**: write the event to the database in the same transaction as the business change, then publish it asynchronously.
- **Idempotency**: running the same operation more than once has the same effect as running it once.
- **DLQ**: dead-letter queue, where jobs go after exhausting retries.
- **KEDA**: Kubernetes autoscaler that scales on external signals such as queue depth.
