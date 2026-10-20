// Shared helpers. Tenants come from: pnpm seed -- --tenants 100 --contacts 1000
import http from 'k6/http';

export const BASE = __ENV.BASE_URL || 'http://localhost:4000';
export const TENANTS = Number(__ENV.TENANTS || 100);
const PASSWORD = __ENV.SEED_PASSWORD || 'relaycrm-demo';
const USER = __ENV.USER_PREFIX || 'loadtest'; // 'growth' for the growth-target dataset
const JSON_HEADERS = { 'content-type': 'application/json' };

function login(i) {
  const r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: `${USER}-${i}@relaycrm.test`, password: PASSWORD }), { headers: JSON_HEADERS, tags: { name: 'login' } });
  if (r.status !== 200) throw new Error(`login ${USER}-${i} failed: ${r.status} ${r.body}`);
  return r.json('accessToken');
}

/**
 * Logs every load-test tenant in once (setup); VUs pass tenant indexes around and get
 * tokens through tokenFor(), which logs in again when a 15-minute access token expires.
 */
export function loginAll(n = TENANTS) {
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(login(i));
  return tokens;
}

const fresh = {}; // per VU: tenant index -> newer token
const EXPIRED_OK = http.expectedStatuses({ min: 200, max: 399 }, 401);
const tokenFor = (tokens, i) => fresh[i] || tokens[i];

/** `t` is { tokens, i }: the setup tokens plus which tenant this request acts as. */
export function api(t, method, path, body, tags = {}) {
  const send = (token, first) =>
    http.request(method, `${BASE}/api/v1${path}`, body === undefined ? null : JSON.stringify(body), {
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      tags: { name: `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, ...tags },
      // An expired token's 401 is expected: it triggers a re-login and a retry.
      ...(first && { responseCallback: EXPIRED_OK }),
    });
  let r = send(tokenFor(t.tokens, t.i), true);
  if (r.status === 401) {
    fresh[t.i] = login(t.i);
    r = send(fresh[t.i], false);
  }
  return r;
}

/** One "business action" that produces a domain event: new deal, then move it to Proposal. */
export function dealThatFiresRule(token, tags) {
  const d = api(token, 'POST', '/deals', { title: `Load deal ${Date.now()}`, value: 60000 + Math.floor(Math.random() * 40000) }, tags);
  if (d.status !== 201) return d;
  return api(token, 'POST', `/deals/${d.json('id')}/move`, { stage: 'proposal' }, tags);
}
