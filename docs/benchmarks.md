# Benchmarks

Measured 2026-10-14 on a laptop. These are single-node numbers, not a capacity claim; they show the design holds its targets (SPECS §8.1) with headroom, and give a baseline to compare against.

## Setup

| | |
|---|---|
| Hardware | Apple M5, 10 cores, 16 GB RAM (everything on one machine, including k6) |
| Processes | 1 API process (`node dist/src/main.js`, `LOG_LEVEL=warn`), 1 worker process, Postgres 18, Redis 8, Mailpit, in Docker Desktop |
| Pools | API `DB_POOL_MAX=10`, worker `DB_POOL_MAX=10`, worker concurrency 10 (events) + 10 (actions), max 5 concurrent runs per tenant |
| Data | 141 tenants, 100,034 contacts (`pnpm seed -- --tenants 100 --contacts 1000`), each load tenant with 2 rules (`high_value_proposal`, `won_handover`) |
| Tool | k6 1.3.0 (`grafana/k6` image); scripts in [`scripts/k6`](../scripts/k6); automation latency from [`scripts/measure-automation.sql`](../scripts/measure-automation.sql) |

Logins for the load tenants happen once in k6 `setup()`. The per-IP auth throttle was raised for the run (`AUTH_RATE_LIMIT`); the per-tenant API limit stayed at the default 100 req/s.

## Results

### 1. Steady: 100 tenants, mixed CRUD, 50 iterations/s for 2 min

`k6 run -e RATE=50 -e DURATION=2m scripts/k6/steady.js`. Mix: 45% list contacts, 15% Kanban board, 20% create contact (`lead.created`), 20% create deal + move to Proposal (`deal.stage_changed`).

| Metric | Result | Target |
|---|---|---|
| Requests | 7,337 (60 req/s), **0 failed** | < 1% errors |
| Read latency (list contacts, board) | p50 4.1 ms · **p95 10.7 ms** · max 63 ms | p95 < 200 ms |
| All requests | p95 10.7 ms · max 65 ms | |
| Domain events | 2,459, **0 left unpublished** | nothing lost |
| Event → first action start | p50 0.12 s · **p95 0.21 s** | p95 < 5 s |
| Event → run finished (task + email) | p95 0.23 s | |

Each stage change matched 2 rules: 1,236 runs succeeded (task + email) and 1,236 were recorded as `skipped` (conditions not met), as designed.

### 1b. Steady, full 30 minutes (SPECS 12.2 scenario 1), on the partitioned schema

`k6 run -e RATE=50 -e DURATION=30m scripts/k6/steady.js`, same mix, after monthly partitioning of run history and activities.

| Metric | Result | Target |
|---|---|---|
| Iterations | 90,001 at 49.9/s; **0 of 90,001 checks failed** | < 1% errors |
| Requests | 118,157 (65.6 req/s). 5,000 of them are the expected `401` at access-token expiry (15 min), each followed by a re-login and a successful retry | |
| Read latency | p50 3.8 ms · **p95 11.6 ms** · max 114 ms | p95 < 200 ms |
| All requests | p95 15.6 ms · max 135 ms | |
| Domain events | 35,922, **0 left unpublished** | nothing lost |
| Event → first action start | p50 0.12 s · **p95 0.21 s**, flat over the 30 minutes | p95 < 5 s |
| Event → run finished | p95 0.22 s; 18,056 runs succeeded, 18,056 skipped by conditions | |

The first attempt at this run exposed a bug in the load script, not the app: k6 logged in once, so every request after minute 15 got `401`. VUs now log in again on `401`.

### 2. Noisy neighbour: one tenant at 10× the others, 1 min

`k6 run -e DURATION=1m scripts/k6/noisy.js`: tenant 0 sends 300 req/s, 19 other tenants share 30 req/s.

| Metric | Result |
|---|---|
| Other tenants' latency | **p95 6.9 ms**, 0 of 1,801 failed |
| Noisy tenant | ~18,000 requests; ~11,900 answered `429 rate_limited`, the rest served (≈ 100 req/s, the per-tenant cap) |

The per-tenant limit is a Redis fixed window shared by all API replicas, so one tenant cannot take the capacity everyone else needs.

### 3. Burst: 1,000 events in ~3 s

`k6 run scripts/k6/burst.js`: 100 VUs, 50 tenants, each iteration creates a deal and moves it to Proposal.

| Metric | Result | Target |
|---|---|---|
| API | 2,050 requests at 742 req/s, **0 failed**, p95 115 ms | |
| Events | 1,000 written, **1,000 published, 1,000 runs succeeded** | nothing dropped |
| Backlog drained | **5.1 s** from first event to last run finished | |
| Event → first action start | p50 2.5 s · **p95 3.2 s** (queueing during the burst) | p95 < 5 s |

### 4. Failure injection: SMTP down

Mailpit stopped, then 20 high-value deals moved to Proposal (each run: create task + send email), then Mailpit started again.

| Check | Result |
|---|---|
| While SMTP was down | email steps failed and were retried with backoff (5 s, 30 s); no run marked failed early |
| 40 s after SMTP came back | **20/20 runs succeeded**, up to 3 tries each |
| Duplicate effects | **20 tasks for 20 runs** (task step keyed `run_id:action_index`, skipped on retry) |

### 5. Growth target: 5,000 tenants, 1M users, 50M contacts

Generated with [`scripts/growth-seed.sql`](../scripts/growth-seed.sql) into a separate database (16 GB: 5,000 tenants x 200 users, 50,000,000 contacts, 500,000 deals, one rule per tenant). Then `k6 run -e USER_PREFIX=growth -e TENANTS=1000 -e RATE=100 -e DURATION=10m scripts/k6/steady.js` (1,000 active tenants, double the steady rate).

| Metric | Result | Target (growth) |
|---|---|---|
| Iterations | 60,001 at 96.9/s; **0 of 60,001 checks failed**, 0 of 72,957 requests failed | |
| Read latency | p50 2.4 ms · **p95 9.1 ms** · max 133 ms | p95 < 300 ms |
| Domain events | 24,123, **0 left unpublished** | |
| Event → first action start | p50 0.12 s · **p95 0.21 s** | p95 < 10 s |

A contacts page for one tenant at 50M rows (`EXPLAIN ANALYZE` as `app_user`): RLS InitPlan + `Index Scan Backward using contacts_tenant_id_id_idx`, 5 buffers, **1.2 ms**. The `tenant_id`-leading index means table size barely matters.

Not reached on this laptop: 1,000 events/s sustained (the growth throughput target). One API and one worker process handled ~40 events/s here with p95 0.21 s, far from saturation; the target needs several worker replicas (KEDA) and was not attempted on a single machine.

### 6. Worker killed mid-run (SPECS 12.1 reliability)

60 high-value deals moved to Proposal (each run: create task + send email); the worker container got `SIGKILL` after 40 events and was restarted 2 s later.

| Check | Result |
|---|---|
| Runs | **60/60 succeeded**, within 6 s of the restart (BullMQ stalled-job recovery re-queued the in-flight jobs) |
| Duplicate effects | **60 tasks, 60 distinct idempotency keys, 60 emails**: nothing lost, nothing doubled |

The first attempt found a real bug (below).

### 7. Read replica

`docker compose --profile replica up` adds a streaming hot standby (`replay_lag` 0.3 ms). With `DATABASE_REPLICA_URL` set, Today, the run log, the Kanban board and GraphQL read from it. Verified by stopping the replica: before the fallback was added those endpoints failed while primary-backed ones kept working (proving the routing); with the fallback they keep answering from the primary. RLS applies on the replica the same way (`app_user` without a tenant sees 0 rows).

### 8. Kubernetes + KEDA on a real cluster

`infra/k8s/overlays/local` applied to a single-node k3s cluster (v1.34, in Docker) with KEDA 2.17: migrate Job → Completed, 2 API pods (HPA), web, PgBouncer, worker with a KEDA `ScaledObject` on the BullMQ wait lists. 5,000 events injected into the outbox:

| t | worker pods | `bull:actions:wait` |
|---|---|---|
| +10 s | 1 | 0 (relay publishing) |
| +20 s | 1 | 3,196 |
| +30 s | **4** | 2,665 |
| +40 s | **8** | 1,185 |
| +50 s | 8 | 0 |
| +60–70 s | 16 → 20 (HPA lag; scales back after the cooldown) | 0 |

All 5,000 runs succeeded, 5,000 tasks with 5,000 distinct idempotency keys.

### 9. Toward 1,000 events/s (growth throughput target)

| Run | Setup | Result |
|---|---|---|
| Ingestion | 60 × 1,000 events, one batch per second | **60,000 events in 60.0 s**, every one published by the relay within seconds; nothing lost |
| First attempt | 20 worker pods direct to Postgres | Postgres hit `max_connections` (100): "too many clients"; 18 runs failed after their retries (in the DLQ). Fixed by putting PgBouncer in front (`infra/k8s/base/pgbouncer.yaml`, Compose profile `scale`); the repeat had zero connection errors |
| Processing | 8 workers on the database's Docker network, 30,000-event backlog over 100 tenants | **248 runs/s** (each run: create task + send email; plus 248 skipped evaluations/s), backlog drained in 121 s |
| Processing | 16 workers through PgBouncer | 63 runs/s: slower |

Follow-up experiments, same 30,000-event backlog:

| Change | runs/s |
|---|---|
| Fewer transactions per run (load + start in one; `create_task` and its step bookkeeping in one; finish merged into the last step: ~9 → ~5 transactions) | 183 (steps: create_task 42 ms avg, send_email 150 ms avg) |
| Same + 50 jobs in flight per worker (instead of 10) | 133: worker processes reach ~70% CPU, Postgres ~2.7 cores, transactions wait on busy event loops |

**Not reached: 1,000 runs/s.** The limit is not CPU (workers ~2% each, Postgres ~1.8 cores): `pg_stat_activity` shows connections "idle in transaction / ClientRead". Each run uses about six interactive transactions with several round trips each, and a connection is held for every round trip; throughput ≈ connections ÷ transaction time, and an extra hop (PgBouncer, or the k3s → host network path) makes every transaction longer. Cutting transactions did not move the number, and more concurrency per process made it worse, so the ceiling on this machine is CPU: one 10-core laptop runs Postgres, Redis, Mailpit, Docker's VM and every worker. Each run is ~5 transactions plus an SMTP send, about 0.2–0.3 s of work spread over Node and Postgres; at ~250 runs/s the box is busy. Reaching 1,000 runs/s is a hardware and topology step (workers on their own nodes scaled by KEDA, a dedicated Postgres, a real SMTP provider), not a design change. It stays an unverified target until it runs on such hardware.

### 10. Redis failover (Sentinel)

Compose profile `ha`: Redis primary, one replica, three Sentinels; API and worker started with `REDIS_SENTINELS`. A rule fired before, during and after `docker stop` of the primary:

| Check | Result |
|---|---|
| Failover | Sentinel promoted the replica **~4 s** after the primary stopped |
| Runs | **3/3 succeeded**, including the one fired while there was no primary (its event waited in the Postgres outbox) |
| API | `/health` 200 throughout |

## Found and fixed by these runs

- **Lost queue jobs left runs stuck forever.** While worker pods were being rescaled and restarted under load, 26,473 runs ended up `queued` in Postgres with no job left in Redis. At-least-once needs a safety net, so a reaper now runs every minute: runs stuck in queued/running for 5+ minutes whose job is not live get a fresh job (safe because finished steps are skipped and every step dedupes). It recovered all 26,473; afterwards, across 240,741 rule-created tasks there were 240,741 distinct idempotency keys (no duplicates). Run start-up errors are now inside the retry/DLQ handling, and transactions wait up to 10 s for a pooled connection instead of 2 s. Regression test: `the reaper revives a run whose queue job was lost`.
- **Connection exhaustion with many workers** (above): PgBouncer added to the base manifests and Compose.

- **Concurrency slots leaked on worker crash.** The per-tenant cap was an `INCR`/`DECR` counter whose TTL was refreshed on every attempt; a killed worker never decremented it, so the tenant stayed "full" and its runs waited forever (41 runs stuck in the first crash test). Slots are now leases in a Redis sorted set taken atomically by a Lua script; leases expire after 120 s, so a crash frees them automatically. Regression test: `slots leaked by a crashed worker expire...`.

- **Backlog alert on the dead-letter queue.** The DLQ keeps failed jobs on purpose, so its oldest-job age grows forever and would page constantly; the alert and dashboard panel now exclude it (seen on the Grafana dashboard during the 30-minute run).
- **Pool starvation under bursts.** Each event job held a transaction and opened a second one to load rules; with 10 concurrent jobs and a 10-connection pool, jobs waited for a connection that never came free ("Unable to start a transaction in the given time"). Fixed by loading rules inside the same transaction. Event jobs also had no retries, so 7 events were dropped; they now retry 8 times with exponential backoff, and the 7 were replayed. Regression test: `a burst of events drains completely` in `apps/api/test/automation.test.ts`.

## Not measured yet

- 1,000 runs/s processing (see 9: 248 runs/s measured, bottleneck identified).
- A multi-node cluster or managed Postgres/Redis; everything here ran on one laptop.
