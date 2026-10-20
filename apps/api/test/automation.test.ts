// End to end: API writes + outbox → relay → BullMQ → worker → actions.
// Needs Postgres, Redis and (optionally) Mailpit, as in docker compose.
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';
import { makeQueue, queueConnection, QUEUES } from '../src/infra';
import { createWorker } from '../src/worker';

let app: INestApplication;
let base: string;
let worker: ReturnType<typeof createWorker>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked by assertions
type Res = { status: number; body: any; headers: Headers };
async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const email = (who: string) => `${who}-${randomBytes(4).toString('hex')}@example.test`;
const password = 'correct horse battery';
const signup = async (company: string) => (await call('POST', '/auth/signup', { company, name: `${company} Owner`, email: email(company.toLowerCase()), password })).body;

before(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  worker = createWorker({ relayIntervalMs: 50, schedule: false });
  await worker.start();
});

after(async () => {
  await worker.stop();
  await app.close();
});

test('deal.stage_changed → create_task + send_email, exactly once', async () => {
  const a = await signup('Acme');
  const t = a.accessToken;
  const installed = await call('POST', '/automation/templates/high_value_proposal/install', undefined, t);
  assert.equal(installed.status, 201);

  const deal = (await call('POST', '/deals', { title: 'ERP integration', value: 64000 }, t)).body;
  assert.equal((await call('POST', `/deals/${deal.id}/move`, { stage: 'proposal' }, t)).status, 201);

  const run = await until(async () => {
    const r = (await call('GET', '/automation/runs', undefined, t)).body.data[0];
    return r?.status === 'succeeded' && r;
  }, 'run to succeed');
  const detail = (await call('GET', `/automation/runs/${run.id}`, undefined, t)).body;
  assert.deepEqual(detail.steps.map((s: { status: string }) => s.status), ['succeeded', 'succeeded']);
  assert.equal(detail.idempotencyKey, `${detail.ruleId}:${detail.eventId}`);

  const page = (await call('GET', `/deals/${deal.id}`, undefined, t)).body;
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].title, 'Review ERP integration');
  assert.equal(page.tasks[0].assigneeId, a.user.id);

  // Duplicate delivery (e.g. relay crashed after enqueue, before marking published):
  // the same event processed again must not create a second run or task.
  const q = makeQueue(QUEUES.events);
  await q.add('deal.stage_changed', { eventId: detail.eventId, tenantId: a.tenant.id }, { jobId: `${detail.eventId}-dup` });
  await new Promise((r) => setTimeout(r, 1500));
  await q.close();
  assert.equal((await call('GET', '/automation/runs', undefined, t)).body.data.length, 1);
  assert.equal((await call('GET', `/deals/${deal.id}`, undefined, t)).body.tasks.length, 1);

  // Conditions not met → recorded as skipped, nothing created.
  const small = (await call('POST', '/deals', { title: 'Tiny', value: 100 }, t)).body;
  await call('POST', `/deals/${small.id}/move`, { stage: 'proposal' }, t);
  await until(async () => (await call('GET', '/automation/runs?status=skipped', undefined, t)).body.data[0], 'skipped run');
  assert.equal((await call('GET', `/deals/${small.id}`, undefined, t)).body.tasks.length, 0);

  const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
  const found = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${a.user.email}"`)}`).then((r) => r.json() as Promise<{ messages_count: number }>).catch(() => null);
  if (found) assert.equal(found.messages_count, 1, 'one email in Mailpit');
});

test("a job carrying tenant B cannot act on tenant A's event", async () => {
  const a = await signup('Initech');
  const b = await signup('Umbrella');
  await call('POST', '/automation/templates/won_handover/install', undefined, a.accessToken);
  await call('POST', '/automation/templates/won_handover/install', undefined, b.accessToken);
  const deal = (await call('POST', '/deals', { title: 'A deal', value: 10 }, a.accessToken)).body;
  await call('POST', `/deals/${deal.id}/move`, { stage: 'won' }, a.accessToken);
  const run = await until(async () => (await call('GET', '/automation/runs', undefined, a.accessToken)).body.data[0], "A's run");

  const q = makeQueue(QUEUES.events);
  const eventId = (await call('GET', `/automation/runs/${run.id}`, undefined, a.accessToken)).body.eventId;
  await q.add('deal.stage_changed', { eventId, tenantId: b.tenant.id }, { jobId: `${eventId}-forged` });
  await new Promise((r) => setTimeout(r, 1500));
  await q.close();
  assert.equal((await call('GET', '/automation/runs', undefined, b.accessToken)).body.data.length, 0, 'B got no run');
  assert.equal((await call('GET', '/tasks', undefined, b.accessToken)).body.data.length, 0, 'B got no task');
});

test('failed step → failed run; retry skips steps that already succeeded', async () => {
  const a = await signup('Hooli');
  const t = a.accessToken;
  // Step 0 succeeds; step 1 cannot succeed (deal has no contact, so no recipient): non-retryable.
  const rule = await call('POST', '/automation/rules', {
    name: 'Broken email', triggerType: 'deal.stage_changed', conditions: { all: [] },
    actions: [
      { type: 'create_task', params: { title: 'Call {{contact.name}}' } },
      { type: 'send_email', params: { to: '{{contact.email}}', template: 'follow_up' } },
    ],
  }, t);
  assert.equal(rule.status, 201);
  const deal = (await call('POST', '/deals', { title: 'No contact', value: 1 }, t)).body;
  await call('POST', `/deals/${deal.id}/move`, { stage: 'qualified' }, t);

  const run = await until(async () => {
    const r = (await call('GET', '/automation/runs?status=failed', undefined, t)).body.data[0];
    return r && r;
  }, 'failed run');
  const d1 = (await call('GET', `/automation/runs/${run.id}`, undefined, t)).body;
  assert.deepEqual(d1.steps.map((s: { status: string }) => s.status), ['succeeded', 'failed']);
  assert.match(d1.error, /No valid recipient/);
  assert.equal(d1.steps[1].history.length, 1);
  assert.equal(d1.steps[1].history[0].deadLettered, true, 'non-retryable failure goes straight to the DLQ');

  assert.equal((await call('POST', `/automation/runs/${run.id}/retry`, undefined, t)).status, 202);
  await until(async () => {
    const r = (await call('GET', `/automation/runs/${run.id}`, undefined, t)).body;
    return r.status === 'failed' && r.attempt === 2 && r;
  }, 'retried run to fail again');
  assert.equal((await call('GET', `/deals/${deal.id}`, undefined, t)).body.tasks.length, 1, 'retry did not create a second task');
});

test('dry run evaluates without side effects', async () => {
  const a = await signup('Soylent');
  const t = a.accessToken;
  const tmpl = (await call('GET', '/automation/templates', undefined, t)).body.find((x: { key: string }) => x.key === 'high_value_proposal');
  const r = await call('POST', '/automation/rules/test', { rule: tmpl.rule }, t);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'sample');
  assert.equal(r.body.matched, true);
  assert.equal(r.body.actions.length, 2);
  assert.equal((await call('GET', '/tasks', undefined, t)).body.data.length, 0);
});

test('public lead form → contact + lead.created rule', async () => {
  const a = await signup('Wonka');
  const t = a.accessToken;
  await call('POST', '/automation/templates/hot_lead_fast/install', undefined, t);
  const [form] = (await call('GET', '/forms', undefined, t)).body;
  const shown = await call('GET', `/public/forms/${a.tenant.id}/${form.id}`);
  assert.equal(shown.body.tenant, 'Wonka');
  assert.equal((await call('POST', `/public/forms/${a.tenant.id}/${form.id}`, { name: 'Charlie' })).status, 400, 'email is required');
  assert.equal((await call('POST', `/public/forms/${a.tenant.id}/${form.id}`, { name: 'Charlie', email: 'charlie@example.test', message: 'Hi' })).status, 201);
  // Honeypot: accepted silently, nothing stored.
  await call('POST', `/public/forms/${a.tenant.id}/${form.id}`, { name: 'Bot', email: 'bot@example.test', website: 'spam.example' });

  const contacts = (await call('GET', '/contacts', undefined, t)).body.data;
  assert.deepEqual(contacts.map((c: { name: string }) => c.name), ['Charlie']);
  assert.equal(contacts[0].ownerId, a.user.id);
  await until(async () => (await call('GET', '/tasks', undefined, t)).body.data.find((x: { title: string }) => x.title === 'Call Charlie now'), 'hot lead task');
});

test('a burst of events drains completely (no pool starvation, nothing dropped)', async () => {
  const a = await signup('Burst');
  const t = a.accessToken;
  await call('POST', '/automation/rules', {
    name: 'Tag every lead', triggerType: 'lead.created', conditions: { all: [] },
    actions: [{ type: 'create_task', params: { title: 'Call {{contact.name}}', assignee: 'contact_owner' } }],
  }, t);
  const N = 40; // > events concurrency (10) and > DB pool (10)
  await Promise.all(Array.from({ length: N }, (_, i) => call('POST', '/contacts', { name: `Lead ${i}` }, t)));
  await until(async () => {
    const runs = (await call('GET', '/automation/runs?status=succeeded&limit=100', undefined, t)).body.data;
    return runs.length === N && runs;
  }, `${N} succeeded runs`, 30_000);
  assert.equal((await call('GET', '/tasks?limit=100', undefined, t)).body.data.length, N);
});

test('over the monthly run quota → runs are skipped with a visible reason', async () => {
  const a = await signup('Quota');
  const t = a.accessToken;
  process.env.RUN_QUOTA_FREE = '2';
  try {
    await call('POST', '/automation/templates/won_handover/install', undefined, t);
    for (let i = 0; i < 3; i++) {
      const d = (await call('POST', '/deals', { title: `Q${i}` }, t)).body;
      await call('POST', `/deals/${d.id}/move`, { stage: 'won' }, t);
    }
    const skipped = await until(async () => {
      const r = (await call('GET', '/automation/runs?status=skipped', undefined, t)).body.data;
      return r.length === 1 && r;
    }, 'one quota-skipped run');
    assert.equal((await call('GET', `/automation/runs/${skipped[0].id}`, undefined, t)).body.skipReason, 'quota_exceeded');
    await until(async () => (await call('GET', '/automation/runs?status=succeeded', undefined, t)).body.data.length === 2, 'two runs within quota');
  } finally {
    delete process.env.RUN_QUOTA_FREE;
  }
});

test('slots leaked by a crashed worker expire instead of blocking the tenant forever', async () => {
  const a = await signup('Crashy');
  const t = a.accessToken;
  // A worker died holding every slot of this tenant: leases already past their expiry.
  const redis = queueConnection();
  const past = Date.now() - 1000;
  await redis.zadd(`slots:${a.tenant.id}`, ...Array.from({ length: 5 }, (_, i) => [past, `dead-${i}`]).flat());
  await call('POST', '/automation/templates/won_handover/install', undefined, t);
  const d = (await call('POST', '/deals', { title: 'After crash' }, t)).body;
  await call('POST', `/deals/${d.id}/move`, { stage: 'won' }, t);
  await until(async () => (await call('GET', '/automation/runs?status=succeeded', undefined, t)).body.data.length === 1, 'run despite leaked slots');
  assert.equal(await redis.zcard(`slots:${a.tenant.id}`), 0, 'expired leases cleaned, own lease released');
  redis.disconnect();
});

test('the reaper revives a run whose queue job was lost, without repeating finished steps', async () => {
  const { Client } = await import('pg');
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  try {
    const a = await signup('Reaped');
    const t = a.accessToken;
    await call('POST', '/automation/templates/won_handover/install', undefined, t);
    const d = (await call('POST', '/deals', { title: 'Lost job' }, t)).body;
    await call('POST', `/deals/${d.id}/move`, { stage: 'won' }, t);
    const run = await until(async () => (await call('GET', '/automation/runs?status=succeeded', undefined, t)).body.data[0], 'first run');

    // Simulate a lost job: the run is stuck in "queued" (started long ago) and no job exists for it.
    await owner.query(`UPDATE automation_runs SET status = 'queued', started_at = now() - interval '20 minutes', finished_at = NULL WHERE id = $1`, [run.id]);
    const maintenance = makeQueue(QUEUES.maintenance);
    await maintenance.add('reap', {});
    await until(async () => (await call('GET', `/automation/runs/${run.id}`, undefined, t)).body.status === 'succeeded', 'reaped run to succeed');
    await maintenance.close();
    assert.equal((await call('GET', `/deals/${d.id}`, undefined, t)).body.tasks.length, 1, 'finished step was not repeated');
  } finally {
    await owner.end();
  }
});
