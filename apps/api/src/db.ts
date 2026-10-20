import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client';

export type Tx = Prisma.TransactionClient;

// Under bursts a transaction may wait for a pooled connection; wait (bounded) instead of
// failing after Prisma's 2 s default.
const TX = { maxWait: Number(process.env.TX_MAX_WAIT_MS ?? 10_000), timeout: Number(process.env.TX_TIMEOUT_MS ?? 15_000) };

const pool = (connectionString: string) => new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });

/**
 * Tenant sharding ("cells", SPECS 8.3 stage 5). DATABASE_URL is the default cell and also
 * holds the directory (tenant_shards, user_shards, refresh_tokens). SHARDS adds more
 * cells: {"cell-b": "postgresql://..."}; each runs the full schema. A tenant lives in
 * exactly one cell, and so do its users (a user cannot join tenants in two cells).
 */
const shardUrls = (): Record<string, string> => (process.env.SHARDS ? JSON.parse(process.env.SHARDS) : {});
export const DEFAULT_SHARD = 'default';

@Injectable()
export class Db extends PrismaClient implements OnModuleDestroy {
  /** Streaming replica of the default cell for heavy read-only pages. */
  private readonly replica?: PrismaClient;
  private readonly cells = new Map<string, PrismaClient>();
  // Placement never changes once written, so caching it forever is safe.
  private readonly tenantCell = new Map<string, string>();

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    // One pool per process (per cell). Keep (api replicas + worker replicas) × DB_POOL_MAX
    // below Postgres max_connections, or put PgBouncer (transaction mode) in front.
    super({ adapter: pool(connectionString) });
    if (process.env.DATABASE_REPLICA_URL) this.replica = new PrismaClient({ adapter: pool(process.env.DATABASE_REPLICA_URL) });
    for (const [name, url] of Object.entries(shardUrls())) this.cells.set(name, new PrismaClient({ adapter: pool(url) }));
  }

  shardNames() {
    return [DEFAULT_SHARD, ...this.cells.keys()];
  }

  cell(shard: string): PrismaClient {
    if (shard === DEFAULT_SHARD) return this;
    const c = this.cells.get(shard);
    if (!c) throw new Error(`Unknown shard ${shard}`);
    return c;
  }

  /** Which cell new tenants go to. ponytail: one configured cell; pick by load when there are many. */
  signupShard() {
    return process.env.SIGNUP_SHARD ?? DEFAULT_SHARD;
  }

  async shardOfTenant(tenantId: string) {
    if (!this.cells.size) return DEFAULT_SHARD;
    let shard = this.tenantCell.get(tenantId);
    if (!shard) {
      shard = (await this.tenantShard.findUnique({ where: { tenantId } }))?.shard ?? DEFAULT_SHARD;
      this.tenantCell.set(tenantId, shard);
    }
    return shard;
  }

  /** Cell holding this user (by email or id). Users without a directory row predate sharding: default cell. */
  async shardOfUser(where: { email: string } | { userId: string }) {
    if (!this.cells.size) return DEFAULT_SHARD;
    return (await this.userShard.findUnique({ where }))?.shard ?? DEFAULT_SHARD;
  }

  private async tenantTx<T>(client: PrismaClient, tenantId: string, fn: (tx: Tx) => Promise<T>) {
    return client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }, TX);
  }

  /**
   * Runs fn in one transaction scoped to a tenant, in the tenant's cell; RLS hides every
   * other tenant's rows. set_config(..., true) is transaction-local, so it never leaks to
   * the next user of a pooled connection (safe with PgBouncer transaction pooling).
   */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tenantTx(this.cell(await this.shardOfTenant(tenantId)), tenantId, fn);
  }

  /**
   * Same as withTenant, on the read replica when one is configured. For dashboards and
   * history where replication lag (usually milliseconds) is fine; never for read-your-write.
   */
  async withTenantRead<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    // ponytail: replica only for the default cell; give each cell its own replica URL if needed.
    if (!this.replica || (await this.shardOfTenant(tenantId)) !== DEFAULT_SHARD) return this.withTenant(tenantId, fn);
    return this.tenantTx(this.replica, tenantId, fn).catch((err: unknown) => {
      // Replica down or restarting: serve from the primary instead of failing the page.
      const e = err as { code?: string; message?: string; stack?: string };
      if (!/ECONNREFUSED|ECONNRESET|ETIMEDOUT|connect|terminat/i.test(`${e?.code} ${e?.message} ${e?.stack?.split('\n')[0]}`)) throw err;
      return this.withTenant(tenantId, fn);
    });
  }

  /** Lets an already-authenticated user read their own memberships (login, before a tenant is chosen). */
  async withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.cell(await this.shardOfUser({ userId })).$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    }, TX);
  }

  async onModuleDestroy() {
    await Promise.all([this.$disconnect(), this.replica?.$disconnect(), ...[...this.cells.values()].map((c) => c.$disconnect())]);
  }
}
