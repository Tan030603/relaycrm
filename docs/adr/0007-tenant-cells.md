# 7. Tenant cells behind a directory

Status: accepted

## Context
One Postgres eventually stops being enough, and a few large tenants can dominate it. SPECS 8.3 stage 5 calls for mapping tenants to shards, with big tenants on a dedicated database.

## Decision
A cell is a full RelayCRM database (same schema, same migrations). The default cell (`DATABASE_URL`) also holds the directory: `tenant_shards` (tenant → cell), `user_shards` (user/email → cell) and refresh tokens. Extra cells come from `SHARDS` (`{"name": "postgresql://..."}`). `Db.withTenant` looks up the tenant's cell (cached forever: placement never changes) and runs the transaction there, so controllers did not change. Login resolves the cell from the email. The worker's relay, retention and idle scan loop over all cells. New tenants go to `SIGNUP_SHARD`.

## Consequences
- Data for a tenant lives in exactly one database; isolation inside a cell is still RLS.
- `user_shards.email` is unique, so an email is unique across all cells.
- A user's tenants must share a cell; inviting an account from another cell is refused (409). Lifting this needs identity in a global service.
- Moving a tenant between cells is an offline copy + directory update (not automated).
- Tested in `apps/api/test/shards.test.ts` with two databases.
