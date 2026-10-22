// Scenario 2: one tenant sends 10x the load; the others' p95 must stay within target.
// The per-tenant rate limit (TENANT_RATE_LIMIT, default 100 req/s) should 429 the noisy one.
import { check } from 'k6';
import { api, loginAll } from './lib.js';

const DURATION = __ENV.DURATION || '1m';
export const options = {
  scenarios: {
    noisy: { executor: 'constant-arrival-rate', rate: 300, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 100, maxVUs: 300, exec: 'noisy' },
    others: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 20, maxVUs: 60, exec: 'others' },
  },
  thresholds: {
    'http_req_duration{scenario:others}': ['p(95)<200'],
    'http_req_failed{scenario:others}': ['rate<0.01'],
  },
};

export const setup = () => ({ tokens: loginAll(20) });

export function noisy({ tokens }) {
  const r = api({ tokens, i: 0 }, 'GET', '/contacts?limit=25');
  check(r, { 'noisy served or limited': (x) => x.status === 200 || x.status === 429 });
}

export function others({ tokens }) {
  const t = { tokens, i: 1 + Math.floor(Math.random() * (tokens.length - 1)) };
  check(api(t, 'GET', '/contacts?limit=25'), { 'others 200': (r) => r.status === 200 });
}
