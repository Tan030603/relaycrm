import 'reflect-metadata';
import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Res,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import client from 'prom-client';
import { ZodError } from 'zod';
import { AuthController, Tokens } from './auth/auth.controller';
import { AuthGuard } from './auth/session';
import { AutomationController } from './automation/automation.controller';
import { ContactsController } from './contacts.controller';
import { Db } from './db';
import { DealsController } from './deals.controller';
import { FormsController, PublicFormsController } from './forms.controller';
import { GraphqlController } from './graphql.controller';
import { Idempotent } from './idempotency';
import { closeRedis, log } from './infra';
import { TasksController } from './tasks.controller';
import { TeamController } from './team.controller';
import { TodayController } from './today.controller';

client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'relaycrm_http_request_duration_seconds',
  help: 'API latency by route and status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
});

@Controller('health')
class HealthController {
  constructor(private readonly db: Db) {}

  @Get()
  async check() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}

@Controller('metrics')
class MetricsController {
  @Get()
  async metrics(@Res() res: Response) {
    res.setHeader('content-type', client.register.contentType);
    res.end(await client.register.metrics());
  }
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  422: 'unprocessable',
  429: 'rate_limited',
  503: 'unavailable',
};

/** Every error leaves as { error: { code, message, details, requestId } }. */
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'internal';
    let message = 'Something went wrong';
    let details: unknown;

    if (err instanceof ZodError) {
      status = 400;
      code = 'validation_failed';
      message = 'Invalid request';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = CODES[status] ?? 'error';
      const r = err.getResponse();
      message = typeof r === 'string' ? r : String((r as { message?: unknown }).message ?? err.message);
    } else if ((err as { code?: string })?.code === 'P2002') {
      status = 409;
      code = 'conflict';
      message = 'Already exists';
    } else {
      log.error({ request_id: req.id, err }, 'unhandled error');
    }
    res.status(status).json({ error: { code, message, details, requestId: req.id } });
  }
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set (32+ characters)');
  return secret;
}

@Module({
  imports: [
    JwtModule.registerAsync({ useFactory: () => ({ secret: jwtSecret(), signOptions: { expiresIn: '15m' } }) }),
    // ponytail: in-memory limits, per API instance. Move to Redis storage once Redis
    // joins the stack (Phase 3) so the limit holds across replicas.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 10) }]),
  ],
  controllers: [
    HealthController, MetricsController, AuthController, TeamController, ContactsController, DealsController,
    TasksController, TodayController, AutomationController, FormsController, PublicFormsController, GraphqlController,
  ],
  providers: [Db, AuthGuard, Tokens, Idempotent],
})
class AppModule implements OnApplicationShutdown {
  onApplicationShutdown() {
    closeRedis();
  }
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
  app.set('trust proxy', 1); // real client IP behind one load balancer (per-IP throttling)
  // Request id + one structured log line per request, tagged with the tenant.
  app.use((req: Request & { id?: string; session?: { tenantId: string } }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const secs = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      httpDuration.observe({ method: req.method, route, status: res.statusCode }, secs);
      if (route !== '/health' && route !== '/metrics')
        log.info({ request_id: req.id, tenant_id: req.session?.tenantId, method: req.method, route, status: res.statusCode, ms: Math.round(secs * 1000) }, 'request');
    });
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
  // Finish in-flight requests and close the DB pool on SIGTERM (rolling deploys).
  app.enableShutdownHooks();
  return app;
}
