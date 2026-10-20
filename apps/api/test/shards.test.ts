// Tenant cells: a second database ("cell b") next to the default one.
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Client } from 'pg';

const cellUrl = (url: string) => url.replace(/\/(\w+)(\?|$)/, '/$1_b$2');
process.env.SHARDS = JSON.stringify({ b: process.env.SHARD_B_DATABASE_URL ?? cellUrl(process.env.DATABASE_URL!) });

let app: INestApplication;
let base: string;
let worker: { start(): Promise<void>; stop(): Promise<void> };
const ownerB = new Client({ connectionString: process.env.SHARD_B_MIGRATION_URL ?? cellUrl(process.env.MIGRATION_DATABASE_URL!) });
const ownerDefault = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked by assertions
async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const email = (who: string) => `${who}-${randomBytes(4).toString('hex')}@example.test`;
const password = 'correct horse battery';

before(async () => {
  // Imported after SHARDS is set: Db reads it when constructed.
  const { createApp } = await import('../src/app');
  const { createWorker } = await import('../src/worker');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  worker = createWorker({ relayIntervalMs: 50, schedule: false });
  await worker.start();
  await Promise.all([ownerB.connect(), ownerDefault.connect()]);
});

after(async () => {
  await worker.stop();
  await app.close();
  await Promise.all([ownerB.end(), ownerDefault.end()]);
  delete process.env.SIGNUP_SHARD;
});

test('a tenant placed in cell b lives only in that database and works end to end', async () => {
  process.env.SIGNUP_SHARD = 'b';
  const bEmail = email('cellb');
  const b = (await call('POST', '/auth/signup', { company: 'Cell B Co', name: 'Bea', email: bEmail, password })).body;
  delete process.env.SIGNUP_SHARD;
  const d = (await call('POST', '/auth/signup', { company: 'Default Co', name: 'Dee', email: email('celld'), password })).body;

  const inB = await ownerB.query('SELECT 1 FROM tenants WHERE id = $1', [b.tenant.id]);
  const inDefault = await ownerDefault.query('SELECT 1 FROM tenants WHERE id = $1', [b.tenant.id]);
  assert.deepEqual([inB.rowCount, inDefault.rowCount], [1, 0], 'tenant row only in cell b');
  assert.equal((await ownerDefault.query('SELECT shard FROM tenant_shards WHERE tenant_id = $1', [b.tenant.id])).rows[0].shard, 'b');

  // Login finds the cell from the email directory; data stays in the cell.
  const login = await call('POST', '/auth/login', { email: bEmail, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.tenant.id, b.tenant.id);
  const name = `Only in B ${randomBytes(4).toString('hex')}`;
  await call('POST', '/contacts', { name }, login.body.accessToken);
  assert.equal((await ownerB.query('SELECT count(*)::int AS n FROM contacts WHERE name = $1', [name])).rows[0].n, 1);
  assert.equal((await ownerDefault.query('SELECT count(*)::int AS n FROM contacts WHERE name = $1', [name])).rows[0].n, 0);
  assert.equal((await call('GET', '/contacts', undefined, d.accessToken)).body.data.length, 0);

  // The worker relays and runs cell b's events too.
  await call('POST', '/automation/templates/won_handover/install', undefined, b.accessToken);
  const deal = (await call('POST', '/deals', { title: 'Cell deal' }, b.accessToken)).body;
  await call('POST', `/deals/${deal.id}/move`, { stage: 'won' }, b.accessToken);
  const end = Date.now() + 15_000;
  let runs: { status: string }[] = [];
  while (Date.now() < end && !runs.some((r) => r.status === 'succeeded')) {
    runs = (await call('GET', '/automation/runs', undefined, b.accessToken)).body.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(runs.some((r) => r.status === 'succeeded'), 'run in cell b succeeded');
});

test('emails are unique across cells, and a user cannot join a tenant in another cell', async () => {
  process.env.SIGNUP_SHARD = 'b';
  const shared = email('shared');
  const b = await call('POST', '/auth/signup', { company: 'B2', name: 'B', email: shared, password });
  delete process.env.SIGNUP_SHARD;
  assert.equal(b.status, 201);
  assert.equal((await call('POST', '/auth/signup', { company: 'D2', name: 'D', email: shared, password })).status, 409, 'same email in the default cell');

  const d = (await call('POST', '/auth/signup', { company: 'D3', name: 'D', email: email('d3'), password })).body;
  const inv = (await call('POST', '/invitations', { email: shared, role: 'rep' }, d.accessToken)).body;
  const token = inv.inviteUrl.split('/invite/')[1];
  assert.equal((await call('POST', `/invitations/${token}/accept`, { password })).status, 409);
});
