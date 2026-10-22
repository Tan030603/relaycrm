// Refresh-token rotation, invitations + roles, Idempotency-Key.
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';

let app: INestApplication;
let base: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked by assertions
async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; cookie: string | null }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const cookie = res.headers.get('set-cookie')?.match(/rt=([^;]*)/)?.[1] ?? null;
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie };
}
const email = (who: string) => `${who}-${randomBytes(4).toString('hex')}@example.test`;
const password = 'correct horse battery';

before(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(() => app.close());

test('refresh token rotates; reusing an old one revokes the whole chain', async () => {
  const s = await call('POST', '/auth/signup', { company: 'Rot', name: 'R', email: email('r'), password });
  assert.ok(s.cookie, 'refresh cookie set');
  const r1 = await call('POST', '/auth/refresh', undefined, undefined, { cookie: `rt=${s.cookie}` });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.accessToken && r1.cookie && r1.cookie !== s.cookie);

  // Old token presented again: treated as theft, chain revoked.
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, { cookie: `rt=${s.cookie}` })).status, 401);
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, { cookie: `rt=${r1.cookie}` })).status, 401, 'newest token revoked too');

  const l = await call('POST', '/auth/login', { email: s.body.user.email, password });
  assert.equal((await call('POST', '/auth/logout', undefined, undefined, { cookie: `rt=${l.cookie}` })).status, 204);
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, { cookie: `rt=${l.cookie}` })).status, 401, 'logout revokes');
});

test('invite a rep; reps cannot edit rules or other people’s deals', async () => {
  const owner = (await call('POST', '/auth/signup', { company: 'Team', name: 'Olivia', email: email('o'), password })).body;
  const repEmail = email('rep');
  const inv = await call('POST', '/invitations', { email: repEmail, role: 'rep' }, owner.accessToken);
  assert.equal(inv.status, 201);
  const token = inv.body.inviteUrl.split('/invite/')[1];

  const preview = await call('GET', `/invitations/${token}`);
  assert.deepEqual([preview.body.tenant, preview.body.hasAccount], ['Team', false]);
  const joined = await call('POST', `/invitations/${token}/accept`, { name: 'Ray', password });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.role, 'rep');
  assert.equal(joined.body.tenant.id, owner.tenant.id);
  assert.equal((await call('POST', `/invitations/${token}/accept`, { name: 'Ray', password })).status, 410, 'one use only');

  const rep = joined.body.accessToken;
  assert.equal((await call('GET', '/members', undefined, rep)).body.length, 2);
  assert.equal((await call('POST', '/automation/templates/won_handover/install', undefined, rep)).status, 403);
  assert.equal((await call('POST', '/invitations', { email: email('x') }, rep)).status, 403);

  const ownersDeal = (await call('POST', '/deals', { title: 'Owner deal' }, owner.accessToken)).body;
  assert.equal((await call('POST', `/deals/${ownersDeal.id}/move`, { stage: 'won' }, rep)).status, 403);
  const repsDeal = (await call('POST', '/deals', { title: 'Rep deal' }, rep)).body;
  assert.equal((await call('POST', `/deals/${repsDeal.id}/move`, { stage: 'qualified' }, rep)).status, 201);
  assert.equal((await call('GET', `/deals/${ownersDeal.id}`, undefined, rep)).status, 200, 'reps can read the pipeline');
});

test('Idempotency-Key replays the first response instead of creating twice', async () => {
  const s = (await call('POST', '/auth/signup', { company: 'Idem', name: 'I', email: email('i'), password })).body;
  const key = randomUUID();
  const first = await call('POST', '/contacts', { name: 'Once' }, s.accessToken, { 'idempotency-key': key });
  const again = await call('POST', '/contacts', { name: 'Once' }, s.accessToken, { 'idempotency-key': key });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.body.id, first.body.id);
  assert.equal((await call('GET', '/contacts', undefined, s.accessToken)).body.data.length, 1);
  assert.equal((await call('POST', '/deals', { title: 'x' }, s.accessToken, { 'idempotency-key': key })).status, 422, 'same key, other route');
});
