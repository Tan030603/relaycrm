import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor, UnprocessableEntityException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { Session } from './auth/session';
import { Db } from './db';
import type { Prisma } from './generated/prisma/client';

/**
 * Idempotency-Key on resource-creating POSTs: the first request runs and its response
 * is stored; a retry with the same key gets the same response instead of a duplicate.
 * Keys live 24 h (purged by the worker).
 */
@Injectable()
export class Idempotent implements NestInterceptor {
  constructor(private readonly db: Db) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { session: Session }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return next.handle();
    if (key.length > 100) throw new UnprocessableEntityException('Idempotency-Key too long');
    const { tenantId } = req.session;
    const route = `${req.method} ${req.path}`;

    return from(
      (async () => {
        const claimed = await this.db.withTenant(tenantId, (tx) =>
          tx.idempotencyKey.createMany({ data: [{ tenantId, key, route }], skipDuplicates: true }),
        );
        if (!claimed.count) {
          const prev = await this.db.withTenant(tenantId, (tx) => tx.idempotencyKey.findFirst({ where: { tenantId, key } }));
          if (prev?.route !== route) throw new UnprocessableEntityException('Idempotency-Key was used for a different request');
          if (prev.status === null) throw new ConflictException('A request with this Idempotency-Key is still in progress');
          res.status(prev.status).setHeader('idempotent-replay', 'true');
          return prev.response;
        }
        try {
          const body = await lastValueFrom(next.handle());
          await this.db.withTenant(tenantId, (tx) =>
            tx.idempotencyKey.updateMany({ where: { tenantId, key }, data: { status: 201, response: JSON.parse(JSON.stringify(body ?? null)) as Prisma.InputJsonValue } }),
          );
          return body;
        } catch (err) {
          // Failed requests release the key so the client can retry.
          await this.db.withTenant(tenantId, (tx) => tx.idempotencyKey.deleteMany({ where: { tenantId, key } }));
          throw err;
        }
      })(),
    );
  }
}
