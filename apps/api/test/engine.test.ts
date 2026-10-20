// Unit tests for the pure rule logic: conditions, whitelists, templating.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { actionsSchema, evaluate, parseConditions, parseRule, render, RULE_TEMPLATES } from '../src/automation/engine';

const deal = { deal: { title: 'ERP', value: 64000, stage: 'proposal', owner: { email: 'sam@x.test' } }, contact: { tags: ['vip', 'eu'], company: 'Summit Foods' } };

test('operators', () => {
  const ok = (field: string, op: string, value: unknown) => evaluate(parseConditions('deal.stage_changed', { all: [{ field, op, value }] }), deal).matched;
  assert.ok(ok('deal.value', 'gt', 50000));
  assert.ok(!ok('deal.value', 'lt', 50000));
  assert.ok(ok('deal.value', 'gte', 64000));
  assert.ok(ok('deal.value', 'lte', '64000')); // numeric strings compare as numbers
  assert.ok(ok('deal.stage', 'eq', 'Proposal')); // case-insensitive
  assert.ok(ok('deal.stage', 'neq', 'won'));
  assert.ok(ok('deal.stage', 'in', ['qualified', 'proposal']));
  assert.ok(ok('contact.company', 'contains', 'summit'));
  assert.ok(!ok('deal.value', 'gt', 'abc')); // NaN never matches
});

test('list fields and any/all nesting', () => {
  const g = parseConditions('lead.created', { any: [{ field: 'contact.tags', op: 'contains', value: 'vip' }, { all: [{ field: 'contact.name', op: 'eq', value: 'x' }] }] });
  const r = evaluate(g, deal);
  assert.ok(r.matched);
  assert.equal(r.results.length, 2, 'trace includes every leaf');
  assert.ok(evaluate(parseConditions('lead.created', { all: [] }), {}).matched, 'empty all matches');
});

test('fields are whitelisted per trigger and nesting is capped at 3', () => {
  assert.throws(() => parseConditions('lead.created', { all: [{ field: 'deal.value', op: 'gt', value: 1 }] }), ZodError);
  assert.throws(() => parseConditions('deal.stage_changed', { all: [{ field: 'deal.__proto__', op: 'eq', value: 1 }] }), ZodError);
  const deep = { all: [{ all: [{ all: [{ all: [{ field: 'deal.value', op: 'gt', value: 1 }] }] }] }] };
  assert.throws(() => parseConditions('deal.stage_changed', deep), ZodError);
  assert.throws(() => parseConditions('deal.stage_changed', { all: [{ field: 'deal.value', op: 'regex', value: '.*' }] }), ZodError);
});

test('templates substitute whitelisted variables only, never code', () => {
  assert.equal(render('Review {{deal.title}} for {{ deal.owner.email }}', deal), 'Review ERP for sam@x.test');
  assert.equal(render('{{constructor.constructor}}{{process.env.JWT_SECRET}}', deal), '');
  assert.equal(render('{{deal.title + 1}}', deal), '{{deal.title + 1}}');
});

test('actions are validated', () => {
  assert.throws(() => actionsSchema.parse([{ type: 'run_shell', params: {} }]));
  assert.throws(() => actionsSchema.parse([{ type: 'webhook', params: { url: 'http://example.com' } }]), /https/);
  const [a] = actionsSchema.parse([{ type: 'create_task', params: { title: 'x' } }]);
  assert.deepEqual(a.params, { title: 'x', assignee: 'deal_owner', due_in_hours: 24 });
});

test('every built-in template is a valid rule', () => {
  for (const t of RULE_TEMPLATES) assert.doesNotThrow(() => parseRule(t.rule), t.key);
});
