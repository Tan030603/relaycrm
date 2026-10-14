import 'reflect-metadata';
import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Logger,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/session';
import { ContactsController } from './contacts.controller';
import { Db } from './db';

@Controller('health')
class HealthController {
  constructor(private readonly db: Db) {}

  @Get()
  async check() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

/** Every error leaves as { error: { code, message, details, requestId } }. */
@Catch()
class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

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
      this.log.error({ requestId: req.id, err });
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [HealthController, AuthController, ContactsController],
  providers: [Db, AuthGuard],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
  // Finish in-flight requests and close the DB pool on SIGTERM (rolling deploys).
  app.enableShutdownHooks();
  return app;
}
