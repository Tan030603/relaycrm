// Scenario 1 (spec 12.2): many tenants, mixed CRUD, steady event rate.
// k6 run -e DURATION=30m -e RATE=50 scripts/k6/steady.js
import { check } from 'k6';
import { api, dealThatFiresRule, loginAll } from './lib.js';

const RATE = Number(__ENV.RATE || 50); // iterations/s; ~40% produce a domain event

export const options = {
  scenarios: {
    mixed: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: __ENV.DURATION || '2m', preAllocatedVUs: 50, maxVUs: 200 },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export const setup = () => ({ tokens: loginAll() });

export default function ({ tokens }) {
  const t = { tokens, i: Math.floor(Math.random() * tokens.length) };
  const roll = Math.random();
  if (roll < 0.45) check(api(t, 'GET', '/contacts?limit=25', undefined, { kind: 'read' }), { 'list 200': (r) => r.status === 200 });
  else if (roll < 0.6) check(api(t, 'GET', '/deals/board', undefined, { kind: 'read' }), { 'board 200': (r) => r.status === 200 });
  else if (roll < 0.8) check(api(t, 'POST', '/contacts', { name: `Lead ${Date.now()}`, email: `l${Date.now()}@load.example` }, { kind: 'write' }), { 'contact 201': (r) => r.status === 201 });
  else check(dealThatFiresRule(t, { kind: 'write' }), { 'move 201': (r) => r.status === 201 });
}
