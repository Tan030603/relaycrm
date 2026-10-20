// Second entrypoint, same image: `node dist/src/worker.js`.
// Runs the outbox relay, the events and actions consumers, and the scheduler.
import './tracing';
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { DelayedError, Job, UnrecoverableError, Worker } from 'bullmq';
import { createServer } from 'node:http';
import client from 'prom-client';
import { NonRetryableError, runAction } from './automation/actions';
import { Action, evaluate, Group } from './automation/engine';
import { dealPayload } from './automation/payloads';
import { Db, Tx } from './db';
import type { Prisma } from './generated/prisma/client';
import { QUEUES, QUEUE_PREFIX, closeShared, emit, log, makeQueue, queueConnection, redisOptions, rulesCacheKey } from './infra';

export const MAX_CHAIN_DEPTH = 3; // rule A → B → A stops here
export const MAX_RULES_PER_EVENT = 20; // fan-out guard
const TENANT_CONCURRENCY = Number(process.env.TENANT_CONCURRENCY ?? 5);
const BACKOFF_MS = [5_000, 30_000, 300_000];
const IDLE_DAYS = Number(process.env.IDLE_DAYS ?? 7);

// Monthly automation runs per plan; override with RUN_QUOTA_<PLAN>. Over-quota runs are
// recorded as skipped (reason quota_exceeded), never silently dropped.
const DEFAULT_RUN_QUOTA: Record<string, number> = { free: 10_000, pro: 250_000, enterprise: Infinity };
const runQuota = (plan: string) => Number(process.env[`RUN_QUOTA_${plan.toUpperCase()}`] ?? DEFAULT_RUN_QUOTA[plan] ?? DEFAULT_RUN_QUOTA.free);

type RuleRow = { id: string; name: string; version: number; conditions: Group; actions: Action[] };
type RunJob = { runId: string; tenantId: string; traceparent?: string | null };

const tracer = trace.getTracer('relaycrm-worker');
/** Continues the trace started by the API request that wrote the event (W3C traceparent carried through the outbox). */
function traced<T>(name: string, traceparent: string | null | undefined, attrs: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const parent = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
  return context.with(parent, () =>
    tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}
const currentTraceparent = () => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
};

const runsTotal = new client.Counter({ name: 'relaycrm_runs_total', help: 'Automation runs by final status', labelNames: ['status'] });
const relayed = new client.Counter({ name: 'relaycrm_events_relayed_total', help: 'Outbox events published to the queue' });
const queueDepth = new client.Gauge({ name: 'relaycrm_queue_depth', help: 'Jobs waiting', labelNames: ['queue', 'state'] });
const oldestAge = new client.Gauge({ name: 'relaycrm_queue_oldest_job_age_seconds', help: 'Age of the oldest waiting job', labelNames: ['queue'] });

export function createWorker(opts: { relayIntervalMs?: number; schedule?: boolean } = {}) {
  const db = new Db();
  const conn = queueConnection();
  const eventsQ = makeQueue(QUEUES.events);
  const actionsQ = makeQueue(QUEUES.actions);
  const dlq = makeQueue(QUEUES.dlq);
  const maintenanceQ = makeQueue(QUEUES.maintenance);
  let stopping = false;

  const runJobOpts = (runId: string, attempt: number) => ({
    jobId: `run-${runId}-${attempt}`,
    attempts: BACKOFF_MS.length,
    backoff: { type: 'custom' as const },
  });

  // ---- 1. Outbox relay ---------------------------------------------------------
  // Lease a batch (SKIP LOCKED, so N relays can run), enqueue with jobId = event id
  // (dedupes at the queue), then mark published. If Redis is down, add() throws, the
  // lease expires and the rows are retried: nothing is lost, the outbox is in Postgres.
  async function relayOnce(): Promise<number> {
    let n = 0;
    for (const shard of db.shardNames()) n = Math.max(n, await relayShard(db.cell(shard)));
    return n;
  }

  async function relayShard(cell: ReturnType<Db['cell']>): Promise<number> {
    const rows = await cell.$queryRaw<{ id: string; tenant_id: string; type: string; traceparent: string | null }[]>`SELECT * FROM claim_domain_events(100, 30)`;
    if (!rows.length) return 0;
    // Event jobs retry too (DB blip, deploy): a failed event job must never drop the event.
    await eventsQ.addBulk(
      rows.map((r) => ({ name: r.type, data: { eventId: r.id, tenantId: r.tenant_id, traceparent: r.traceparent }, opts: { jobId: r.id, attempts: 8, backoff: { type: 'exponential', delay: 1000 } } })),
    );
    await cell.$executeRaw`SELECT mark_domain_events_published(${rows.map((r) => r.id)}::uuid[])`;
    relayed.inc(rows.length);
    return rows.length;
  }

  async function relayLoop() {
    while (!stopping) {
      let n = 0;
      try {
        n = await relayOnce();
      } catch (err) {
        log.warn({ err: String(err) }, 'relay failed, will retry');
      }
      // Drain fast while there is a backlog; otherwise poll every 200 ms.
      // ponytail: polling; LISTEN/NOTIFY can wake the relay instantly if latency matters.
      if (n < 100) await new Promise((r) => setTimeout(r, opts.relayIntervalMs ?? 200));
    }
  }

  // ---- 2. Events: match rules, create runs ---------------------------------------
  // Uses the caller's transaction: opening a second one here would need a second pooled
  // connection per job, and under a burst every job would wait for one that never frees up.
  async function cachedRules(tenantId: string, trigger: string): Promise<RuleRow[] | null> {
    const cached = await conn.get(rulesCacheKey(tenantId, trigger)).catch(() => null);
    return cached ? JSON.parse(cached) : null;
  }

  async function enabledRules(tx: Tx, tenantId: string, trigger: string, cached: RuleRow[] | null): Promise<RuleRow[]> {
    if (cached) return cached;
    const key = rulesCacheKey(tenantId, trigger);
    const rules = await tx.automationRule.findMany({
      where: { tenantId, triggerType: trigger, enabled: true },
      select: { id: true, name: true, version: true, conditions: true, actions: true },
      orderBy: { id: 'asc' },
      take: MAX_RULES_PER_EVENT,
    });
    await conn.set(key, JSON.stringify(rules), 'EX', 60).catch(() => {});
    return rules as unknown as RuleRow[];
  }

  function handleEvent(job: Job<{ eventId: string; tenantId: string; traceparent?: string | null }>) {
    return traced(`event ${job.name}`, job.data.traceparent, { 'relaycrm.tenant_id': job.data.tenantId, 'relaycrm.event_id': job.data.eventId }, () => processEvent(job));
  }

  // Plan rarely changes; a minute of staleness on a quota limit is fine.
  const planCache = new Map<string, { plan: string; at: number }>();

  async function processEvent(job: Job<{ eventId: string; tenantId: string }>) {
    const { eventId, tenantId } = job.data;
    // Redis reads happen before the transaction opens, so no connection waits on them.
    const cached = await cachedRules(tenantId, job.name);
    const queued = await db.withTenant(tenantId, async (tx) => {
      // RLS: a job can only see events of its own tenant.
      const ev = await tx.domainEvent.findFirst({ where: { id: eventId, tenantId } });
      if (!ev) return [];
      const p = ev.payload as Record<string, unknown>;

      if (ev.type === 'automation.retry') {
        const run = await tx.automationRun.findFirst({ where: { id: String(p.runId), tenantId } });
        return run ? [{ id: run.id, attempt: run.attempt }] : [];
      }
      if (ev.depth > MAX_CHAIN_DEPTH) {
        log.warn({ event_id: ev.id, tenant_id: tenantId, depth: ev.depth }, 'chain too deep, event dropped');
        return [];
      }

      const rules = await enabledRules(tx, tenantId, ev.type, ev.type === job.name ? cached : null);
      if (!rules.length) return [];
      let plan = planCache.get(tenantId);
      if (!plan || Date.now() - plan.at > 60_000) {
        plan = { plan: (await tx.tenant.findFirst({ select: { plan: true } }))?.plan ?? 'free', at: Date.now() };
        planCache.set(tenantId, plan);
      }
      const matches = rules.map((r) => evaluate(r.conditions, p).matched);
      // One INCRBY for all matched rules of this event (one round trip, not one per rule).
      // ponytail: a redelivered event counts against the quota twice; reconcile from
      // automation_runs monthly if exact billing ever depends on it.
      const matchedCount = matches.filter(Boolean).length;
      let allowed = matchedCount;
      if (matchedCount) {
        const key = `quota:${tenantId}:${new Date().toISOString().slice(0, 7)}`;
        const used = await conn.incrby(key, matchedCount).catch(() => 0);
        if (used === matchedCount) await conn.expire(key, 40 * 86_400).catch(() => {});
        allowed = Math.max(0, Math.min(matchedCount, runQuota(plan.plan) - (used - matchedCount)));
      }
      const data = [];
      for (const [k, r] of rules.entries()) {
        let matched = matches[k];
        let skipReason = matched ? null : 'conditions_not_met';
        if (matched && allowed-- <= 0) [matched, skipReason] = [false, 'quota_exceeded'];
        data.push({
          tenantId, ruleId: r.id, ruleVersion: r.version, eventId: ev.id, eventType: ev.type, aggregateId: ev.aggregateId,
          ruleSnapshot: r as unknown as Prisma.InputJsonValue, payload: ev.payload as Prisma.InputJsonValue,
          idempotencyKey: `${r.id}:${ev.id}`, depth: ev.depth,
          // Same partition for every redelivery of this event, so the unique key still dedupes.
          createdAt: ev.occurredAt,
          status: matched ? ('queued' as const) : ('skipped' as const),
          skipReason,
          finishedAt: matched ? null : new Date(),
        });
      }
      // Duplicate delivery of the same event is a no-op: UNIQUE (tenant_id, idempotency_key).
      await tx.automationRun.createMany({ data, skipDuplicates: true });
      return tx.automationRun.findMany({
        where: { tenantId, createdAt: ev.occurredAt, idempotencyKey: { in: data.map((d) => d.idempotencyKey) }, status: 'queued' },
        select: { id: true, attempt: true },
      });
    });
    if (queued.length)
      await actionsQ.addBulk(queued.map((r) => ({ name: 'run', data: { runId: r.id, tenantId, traceparent: currentTraceparent() } satisfies RunJob, opts: runJobOpts(r.id, r.attempt) })));
  }

  // ---- 3. Actions: execute a run step by step -----------------------------------
  // Two transactions for a typical run, not one per step: every commit is a WAL flush and
  // every round trip holds a pooled connection (docs/benchmarks.md section 9). One
  // transaction walks the actions: database-only ones run inside it, and an external one
  // (email, webhook) ends it by marking its step running. The send happens with no
  // transaction open; the next transaction records its result and carries on.
  async function executeRun(job: Job<RunJob>) {
    const { runId, tenantId } = job.data;
    const isFinal = (err: unknown) => err instanceof NonRetryableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    type Todo = { action: Action; i: number };
    let run: (Prisma.AutomationRunGetPayload<{ include: { steps: true } }>) | undefined;
    let rule!: RuleRow;
    let todo: Todo[] = [];
    let next = 0; // index into todo
    let current: Todo | undefined; // step executing now, for the failure record
    let sent: { i: number; output: unknown; defer: ((tx: Tx) => Promise<unknown>)[] } | undefined; // external step done, not yet committed

    const stepKey = (i: number) => ({ runId_actionIndex_runCreatedAt: { runId, actionIndex: i, runCreatedAt: run!.createdAt } });
    const runKey = () => ({ id_createdAt: { id: runId, createdAt: run!.createdAt } }); // composite key: prunes to one partition
    const stepUpsert = (tx: Tx, { action, i }: Todo, status: 'running' | 'succeeded', output?: unknown) =>
      tx.automationRunStep.upsert({
        where: stepKey(i),
        create: { tenantId, runId, runCreatedAt: run!.createdAt, actionIndex: i, actionType: action.type, status, input: action.params as Prisma.InputJsonValue, output: output as Prisma.InputJsonValue, finishedAt: status === 'succeeded' ? new Date() : null },
        update: { status, error: null, output: output as Prisma.InputJsonValue, startedAt: new Date(), finishedAt: status === 'succeeded' ? new Date() : null, tries: { increment: 1 } },
      });
    const recordSent = async (tx: Tx) => {
      if (!sent) return;
      await tx.automationRunStep.update({ where: stepKey(sent.i), data: { status: 'succeeded', output: sent.output as Prisma.InputJsonValue, finishedAt: new Date() } });
      for (const write of sent.defer) await write(tx);
    };

    try {
      for (;;) {
        const external = await db.withTenant(tenantId, async (tx): Promise<Todo | null> => {
          if (!run) {
            const r = await tx.automationRun.findFirst({ where: { id: runId, tenantId }, include: { steps: true } });
            if (!r || r.status === 'succeeded' || r.status === 'skipped') return null;
            run = r;
            rule = r.ruleSnapshot as unknown as RuleRow;
            todo = rule.actions.map((action, i) => ({ action, i })).filter(({ i }) => r.steps.find((s) => s.actionIndex === i)?.status !== 'succeeded');
            await tx.automationRun.update({ where: runKey(), data: { status: 'running', startedAt: r.startedAt ?? new Date(), attempt: { increment: 1 }, error: null } });
          }
          await recordSent(tx);
          while (next < todo.length) {
            current = todo[next++];
            if (current.action.type !== 'create_task') {
              await stepUpsert(tx, current, 'running');
              return current;
            }
            // Database-only: the effect and its step commit together ('running' would never be visible).
            const output = await traced(`action ${current.action.type}`, currentTraceparent(), { 'relaycrm.run_id': runId }, () =>
              runAction({ ...ctx(current!), tx }, current!.action),
            );
            await stepUpsert(tx, current, 'succeeded', output);
          }
          current = undefined;
          await tx.automationRun.update({ where: runKey(), data: { status: 'succeeded', finishedAt: new Date() } });
          return null;
        });
        sent = undefined; // committed
        if (!external) break;
        const defer: ((tx: Tx) => Promise<unknown>)[] = [];
        const output = await traced(`action ${external.action.type}`, currentTraceparent(), { 'relaycrm.run_id': runId }, () => runAction({ ...ctx(external), defer }, external.action));
        sent = { i: external.i, output, defer };
        current = undefined;
      }
      if (run) {
        runsTotal.inc({ status: 'succeeded' });
        log.debug({ run_id: runId, tenant_id: tenantId, rule_id: rule.id }, 'run succeeded');
      }
    } catch (err) {
      if (!run) throw err; // failed before the run was read: plain job retry
      const final = isFinal(err);
      const failed = current;
      await db.withTenant(tenantId, async (tx) => {
        // A send that succeeded but whose result was in the rolled-back transaction: keep it, so a retry does not repeat it.
        await recordSent(tx);
        if (failed) {
          const { action, i } = failed;
          const step = await tx.automationRunStep.upsert({
            where: stepKey(i),
            create: { tenantId, runId, runCreatedAt: run!.createdAt, actionIndex: i, actionType: action.type, status: 'failed', input: action.params as Prisma.InputJsonValue, error: errMsg(err), finishedAt: new Date() },
            update: { status: 'failed', error: errMsg(err), finishedAt: new Date() },
          });
          const entry = { try: step.tries, error: errMsg(err), at: new Date().toISOString(), ...(final ? { deadLettered: true } : { retryInMs: BACKOFF_MS[job.attemptsMade] }) };
          await tx.$executeRaw`UPDATE automation_run_steps SET history = history || ${JSON.stringify([entry])}::jsonb WHERE id = ${step.id}::uuid AND run_created_at = ${run!.createdAt}`;
        }
        await tx.automationRun.update({
          where: runKey(),
          // queued + error = "retrying" in the UI.
          data: final ? { status: 'failed', error: errMsg(err), finishedAt: new Date() } : { status: 'queued', error: errMsg(err) },
        });
      });
      log.warn({ run_id: runId, tenant_id: tenantId, final, err: errMsg(err) }, 'run step failed');
      if (final) {
        runsTotal.inc({ status: 'failed' });
        await dlq.add('dead', { runId, tenantId, error: errMsg(err) }, { jobId: `dead-${runId}-${run.attempt + 1}` });
        throw new UnrecoverableError(errMsg(err));
      }
      throw err;
    }

    function ctx({ i }: Todo) {
      return { db, tenantId, runId, ruleId: rule.id, ruleName: rule.name, actionIndex: i, payload: run!.payload };
    }
  }

  /**
   * Per-tenant concurrency cap: one tenant flooding the queue cannot take every worker slot.
   * Slots are leases in a sorted set (score = expiry), taken and counted atomically in Lua.
   * A worker that crashes never releases its slots; they expire after SLOT_LEASE_MS.
   */
  const SLOT_LEASE_MS = 120_000; // > the longest run (10 actions x 10 s timeout)
  const ACQUIRE = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[5])
    return 1`;

  async function handleRun(job: Job<RunJob>, token?: string) {
    const key = `slots:${job.data.tenantId}`; // sorted set (the old counter used conc:<tenant>)
    const now = Date.now();
    const slot = `${job.id}:${token}`;
    const got = await conn.eval(ACQUIRE, 1, key, now, now + SLOT_LEASE_MS, TENANT_CONCURRENCY, slot, SLOT_LEASE_MS);
    if (!got) {
      await job.moveToDelayed(Date.now() + 500 + Math.floor(Math.random() * 500), token);
      throw new DelayedError();
    }
    try {
      await traced('run', job.data.traceparent, { 'relaycrm.tenant_id': job.data.tenantId, 'relaycrm.run_id': job.data.runId }, () => executeRun(job));
    } finally {
      await conn.zrem(key, slot);
    }
  }

  // ---- 4. Scheduler: idle deals + retention --------------------------------------
  async function handleMaintenance(job: Job) {
    if (job.name === 'purge') {
      for (const shard of db.shardNames()) {
        const cell = db.cell(shard);
        const [r] = await cell.$queryRaw<{ events: bigint; keys: bigint }[]>`SELECT * FROM purge_old_data()`;
        const [{ dropped }] = await cell.$queryRaw<{ dropped: number }[]>`SELECT drop_old_run_partitions(90) AS dropped`;
        await cell.$queryRaw`SELECT ensure_history_partitions()`;
        log.info({ shard, events: Number(r.events), keys: Number(r.keys), run_partitions_dropped: dropped }, 'retention purge');
      }
      return;
    }
    if (job.name === 'reap') {
      // Runs with no progress (6 min unstarted, 12 min started) whose job is gone get a fresh job.
      // Safe to re-run: steps that already succeeded are skipped and each step dedupes.
      let requeued = 0;
      for (const shard of db.shardNames()) {
        const stale = await db.cell(shard).$queryRaw<{ id: string; tenant_id: string; attempt: number }[]>`SELECT * FROM stale_runs(360, 1000)`;
        for (const r of stale) {
          // The job id carries the attempt number at enqueue time; each execution then bumps
          // the run's attempt, so the live job may be either of these.
          const states = await Promise.all(
            [r.attempt, r.attempt - 1].map(async (a) => (await actionsQ.getJob(`run-${r.id}-${a}`))?.getState()),
          );
          if (states.some((st) => st && ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'].includes(st))) continue;
          await actionsQ.add('run', { runId: r.id, tenantId: r.tenant_id } satisfies RunJob, { ...runJobOpts(r.id, r.attempt), jobId: `run-${r.id}-${r.attempt}-reaped-${Date.now()}` });
          requeued++;
        }
      }
      if (requeued) log.warn({ requeued }, 'reaper re-enqueued stuck runs');
      return;
    }
    if (job.name === 'idle-scan') {
      const deals = [];
      for (const shard of db.shardNames())
        deals.push(...(await db.cell(shard).$queryRaw<{ id: string; tenant_id: string }[]>`SELECT * FROM claim_idle_deals(${IDLE_DAYS}::int, 500)`));
      // ponytail: claim and emit are separate transactions; a crash in between skips that
      // deal's idle event for this stage visit. Emit inside the SQL function if it matters.
      for (const d of deals)
        await db.withTenant(d.tenant_id, async (tx) =>
          emit(tx, { tenantId: d.tenant_id, type: 'deal.idle', aggregateType: 'deal', aggregateId: d.id, payload: await dealPayload(tx, d.id, { idle_days: IDLE_DAYS }) }),
        );
      if (deals.length) log.info({ count: deals.length }, 'idle deals emitted');
    }
  }

  const settings = { backoffStrategy: (attemptsMade: number) => BACKOFF_MS[attemptsMade - 1] ?? BACKOFF_MS.at(-1)! };
  const workers = [
    new Worker(QUEUES.events, handleEvent, { connection: redisOptions(), prefix: QUEUE_PREFIX, concurrency: 10 }),
    new Worker(QUEUES.actions, handleRun, { connection: redisOptions(), prefix: QUEUE_PREFIX, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10), settings }),
    new Worker(QUEUES.maintenance, handleMaintenance, { connection: redisOptions(), prefix: QUEUE_PREFIX, concurrency: 1 }),
  ];
  for (const w of workers) w.on('error', (err) => log.error({ err: String(err) }, 'worker error'));

  async function start() {
    if (opts.schedule !== false) {
      await maintenanceQ.upsertJobScheduler('purge', { pattern: '0 3 * * *' }, { name: 'purge' });
      await maintenanceQ.upsertJobScheduler('idle-scan', { every: 15 * 60_000 }, { name: 'idle-scan' });
      await maintenanceQ.upsertJobScheduler('reap', { every: 60_000 }, { name: 'reap' });
    }
    void relayLoop();
  }

  async function sampleQueues() {
    for (const q of [eventsQ, actionsQ, dlq]) {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, n] of Object.entries(counts)) queueDepth.set({ queue: q.name, state }, n);
      const [oldest] = await q.getJobs(['waiting'], 0, 0, true);
      oldestAge.set({ queue: q.name }, oldest ? (Date.now() - oldest.timestamp) / 1000 : 0);
    }
  }

  /** Graceful shutdown: stop polling, let in-flight jobs finish, close connections. */
  async function stop() {
    stopping = true;
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([eventsQ.close(), actionsQ.close(), dlq.close(), maintenanceQ.close()]);
    conn.disconnect();
    closeShared();
    await db.$disconnect();
  }

  return { start, stop, relayOnce, sampleQueues, db };
}

function errMsg(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

if (require.main === module) {
  const w = createWorker();
  void w.start().then(() => log.info('worker started'));
  const port = Number(process.env.WORKER_METRICS_PORT ?? 9464);
  createServer(async (req, res) => {
    if (req.url === '/metrics') {
      await w.sampleQueues().catch(() => {});
      res.setHeader('content-type', client.register.contentType);
      return res.end(await client.register.metrics());
    }
    res.end(JSON.stringify({ ok: true }));
  }).listen(port);
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      log.info({ sig }, 'worker shutting down');
      void w.stop().then(() => process.exit(0));
    });
}
