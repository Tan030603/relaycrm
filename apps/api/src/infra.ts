import { context, propagation } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import pino from 'pino';
import type { Prisma } from './generated/prisma/client';
import type { Tx } from './db';

/** Structured JSON logs. Emails and phone numbers are scrubbed wherever they appear as fields. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['email', '*.email', '*.*.email', 'phone', '*.phone', 'password', '*.password'], censor: '[redacted]' },
  base: { service: process.env.SERVICE_NAME ?? 'api' },
});

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

/**
 * Connection options (not an instance), so each Queue/Worker owns its connection and
 * close() really closes it. BullMQ needs maxRetriesPerRequest: null for blocking calls.
 * With REDIS_SENTINELS="host:port,host:port" the client asks Sentinel for the current
 * primary and follows a failover on its own (high availability, SPECS 8.3 stage 5).
 */
export function redisOptions() {
  const u = new URL(REDIS_URL);
  const auth = { username: u.username || undefined, password: u.password ? decodeURIComponent(u.password) : undefined };
  if (process.env.REDIS_SENTINELS) {
    return {
      sentinels: process.env.REDIS_SENTINELS.split(',').map((hp) => ({ host: hp.split(':')[0], port: Number(hp.split(':')[1] ?? 26379) })),
      name: process.env.REDIS_SENTINEL_NAME ?? 'relaycrm',
      ...auth,
      maxRetriesPerRequest: null,
    };
  }
  return {
    host: u.hostname, port: Number(u.port || 6379), ...auth, db: Number(u.pathname.slice(1) || 0),
    tls: u.protocol === 'rediss:' ? {} : undefined, maxRetriesPerRequest: null,
  };
}

/** A plain client for the worker's own commands (rules cache, concurrency leases). */
export function queueConnection() {
  return new Redis(redisOptions());
}

/**
 * For the API's own calls (rate limits, cache): fail fast instead of queueing commands
 * while Redis is down, so the API keeps serving (events wait safely in the outbox).
 */
let fast: Redis | undefined;
export function redis() {
  if (!fast) {
    fast = new Redis({ ...redisOptions(), enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    fast.on('error', () => {}); // callers handle failures; avoids unhandled-error spam while Redis is down
  }
  return fast;
}

/** Closes the process-wide clients (fast Redis, SMTP pool) so the process can exit. */
export function closeShared() {
  fast?.disconnect();
  fast = undefined;
  transport?.close();
  transport = undefined;
}

/** Separate key space per environment (tests use "test", so a running dev worker never takes their jobs). */
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX ?? 'bull';

export const QUEUES = { events: 'events', actions: 'actions', dlq: 'dlq', maintenance: 'maintenance' } as const;

export function makeQueue(name: string) {
  return new Queue(name, {
    connection: redisOptions(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } },
  });
}

/** Enabled rules per (tenant, trigger) are cached in Redis; the API drops the key on any rule change. */
export const rulesCacheKey = (tenantId: string, trigger: string) => `rules:${tenantId}:${trigger}`;

export async function invalidateRules(tenantId: string, trigger: string) {
  try {
    await redis().del(rulesCacheKey(tenantId, trigger));
  } catch (err) {
    // Cache TTL is short (60 s), so a missed invalidation heals by itself.
    log.warn({ err: String(err), tenantId }, 'rules cache invalidation failed');
  }
}

export interface DomainEventInput {
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
  depth?: number;
}

/**
 * Transactional outbox: call with the same tx as the business write, so the change
 * and its event commit (or roll back) together. The relay publishes it later.
 */
export function emit(tx: Tx, e: DomainEventInput) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier); // no-op unless tracing is on
  return tx.domainEvent.create({ data: { ...e, depth: e.depth ?? 0, traceparent: carrier.traceparent } });
}

export function audit(tx: Tx, tenantId: string, actorId: string | null, action: string, entity: string, entityId?: string, data?: Prisma.InputJsonValue) {
  return tx.auditLog.create({ data: { tenantId, actorId, action, entity, entityId, data } });
}

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
export function mailer() {
  // Pooled: reusing SMTP connections skips a TCP + EHLO handshake per message.
  transport ??= nodemailer.createTransport({ url: process.env.SMTP_URL ?? 'smtp://localhost:1025', pool: true, maxConnections: Number(process.env.SMTP_POOL ?? 5) });
  return transport;
}
export const MAIL_FROM = process.env.MAIL_FROM ?? 'RelayCRM <no-reply@relaycrm.local>';
