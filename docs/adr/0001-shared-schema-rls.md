# 1. Shared schema with Postgres Row-Level Security

Status: accepted

## Context
Every tenant must be isolated from every other, and a single forgotten `WHERE tenant_id = ?` in application code must not leak data. We expect thousands of small tenants.

## Decision
One database, one schema, `tenant_id` on every tenant-owned table, enforced by RLS policies (`ENABLE` + `FORCE`). The app connects as `app_user` (not superuser, not owner, no `BYPASSRLS`) and sets `app.tenant_id` per transaction with `set_config(..., true)`. Policies call `(SELECT app_tenant_id())` so the setting is read once per query (InitPlan), and `NULLIF(..., '')` makes a missing tenant match nothing (fail closed). Cross-tenant jobs (outbox relay, retention, idle scan) go through `SECURITY DEFINER` functions owned by a `NOLOGIN` role with narrow policies.

## Consequences
- Isolation is proven in SQL (`apps/api/test/rls.test.ts`), including a catalog test that fails if a new tenant table forgets RLS.
- Transaction-local settings are safe with PgBouncer in transaction mode.
- Noisy neighbours share one database: mitigated by per-tenant rate limits and worker concurrency caps; big tenants can later move to their own database ("cells").
- Rejected: schema-per-tenant (migrations × N), database-per-tenant (cost, connections).
