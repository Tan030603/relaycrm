// Scenario 3: 1,000 events in ~10 s. Afterwards every event must have produced its run
// (nothing dropped); measure drain time with scripts/measure-automation.sql.
import { check } from 'k6';
import exec from 'k6/execution';
import { dealThatFiresRule, loginAll } from './lib.js';

export const options = {
  scenarios: { burst: { executor: 'shared-iterations', iterations: Number(__ENV.EVENTS || 1000), vus: 100, maxDuration: '60s' } },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export const setup = () => ({ tokens: loginAll(50) });

export default function ({ tokens }) {
  check(dealThatFiresRule({ tokens, i: exec.scenario.iterationInTest % tokens.length }), { 'event accepted': (r) => r.status === 201 });
}
