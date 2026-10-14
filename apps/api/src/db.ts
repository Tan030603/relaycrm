import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class Db extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    // One pool per process. Keep (api replicas + worker replicas) × DB_POOL_MAX below
    // Postgres max_connections, or put PgBouncer (transaction mode) in front.
    super({ adapter: new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) }) });
  }

  /**
   * Runs fn in one transaction scoped to a tenant; RLS hides every other tenant's rows.
   * set_config(..., true) is transaction-local, so it never leaks to the next user of
   * a pooled connection (safe with PgBouncer transaction pooling).
   */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /** Lets an already-authenticated user read their own memberships (login, before a tenant is chosen). */
  withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
