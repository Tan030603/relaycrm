// End to end through HTTP: signup, login, and tenant isolation at the API level.
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';

let app: INestApplication;
let base: string;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked by assertions
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

const email = (who: string) => `${who}-${randomBytes(4).toString('hex')}@example.test`;
const password = 'correct horse battery';

before(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

after(async () => {
  await app.close();
});

test('signup, login and per-tenant contacts', async () => {
  const aEmail = email('alice');
  const a = await call('POST', '/api/v1/auth/signup', { company: 'Acme', name: 'Alice', email: aEmail, password });
  const b = await call('POST', '/api/v1/auth/signup', { company: 'Globex', name: 'Bob', email: email('bob'), password });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.role, 'owner');

  const created = await call('POST', '/api/v1/contacts', { name: 'Priya Nair', email: 'Priya@Example.test' }, a.body.accessToken);
  assert.equal(created.status, 201);
  assert.equal(created.body.email, 'priya@example.test');

  const aList = await call('GET', '/api/v1/contacts', undefined, a.body.accessToken);
  assert.deepEqual(aList.body.data.map((c: { name: string }) => c.name), ['Priya Nair']);

  const bList = await call('GET', '/api/v1/contacts', undefined, b.body.accessToken);
  assert.deepEqual(bList.body.data, []);

  const bPeek = await call('GET', `/api/v1/contacts/${created.body.id}`, undefined, b.body.accessToken);
  assert.equal(bPeek.status, 404);

  const login = await call('POST', '/api/v1/auth/login', { email: aEmail, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.tenant.id, a.body.tenant.id);
});

test('cursor pagination walks newest first without repeats', async () => {
  const s = await call('POST', '/api/v1/auth/signup', { company: 'Pager', name: 'Pat', email: email('pat'), password });
  for (const n of ['one', 'two', 'three']) await call('POST', '/api/v1/contacts', { name: n }, s.body.accessToken);

  const page1 = await call('GET', '/api/v1/contacts?limit=2', undefined, s.body.accessToken);
  const page2 = await call('GET', `/api/v1/contacts?limit=2&cursor=${page1.body.nextCursor}`, undefined, s.body.accessToken);
  assert.deepEqual(page1.body.data.map((c: { name: string }) => c.name), ['three', 'two']);
  assert.deepEqual(page2.body.data.map((c: { name: string }) => c.name), ['one']);
  assert.equal(page2.body.nextCursor, null);
});

test('errors use one shape and carry a request id', async () => {
  const noToken = await call('GET', '/api/v1/contacts');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error.code, 'unauthorized');
  assert.equal(noToken.body.error.requestId, noToken.headers.get('x-request-id'));

  const bad = await call('POST', '/api/v1/auth/signup', { company: '', name: 'x', email: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'validation_failed');
  assert.ok(bad.body.error.details.length >= 3);

  const wrong = await call('POST', '/api/v1/auth/login', { email: email('ghost'), password });
  assert.equal(wrong.status, 401);
});

test('duplicate email is a conflict', async () => {
  const e = email('dup');
  await call('POST', '/api/v1/auth/signup', { company: 'One', name: 'D', email: e, password });
  const again = await call('POST', '/api/v1/auth/signup', { company: 'Two', name: 'D', email: e, password });
  assert.equal(again.status, 409);
});
