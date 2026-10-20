// Pure rule logic: no framework, no database. Rules are whitelisted JSON, never code.
import { z } from 'zod';

export const TRIGGERS = {
  'lead.created': {
    label: 'A new lead is created',
    fields: { 'contact.name': 'text', 'contact.email': 'text', 'contact.company': 'text', 'contact.source': 'text', 'contact.tags': 'list' },
  },
  'deal.stage_changed': {
    label: 'A deal changes stage',
    fields: { 'deal.title': 'text', 'deal.value': 'number', 'deal.stage': 'text', 'deal.from_stage': 'text', 'deal.currency': 'text', 'contact.company': 'text' },
  },
  'deal.idle': {
    label: 'A deal sits in one stage for 7 days',
    fields: { 'deal.title': 'text', 'deal.value': 'number', 'deal.stage': 'text', 'deal.idle_days': 'number', 'contact.company': 'text' },
  },
} as const;
export type TriggerType = keyof typeof TRIGGERS;
export const triggerTypes = Object.keys(TRIGGERS) as [TriggerType, ...TriggerType[]];

/** Variables templates may use. Anything else renders as an empty string. */
export const TEMPLATE_VARS = [
  'contact.name', 'contact.email', 'contact.company', 'contact.phone', 'contact.owner.name', 'contact.owner.email',
  'deal.title', 'deal.value', 'deal.currency', 'deal.stage', 'deal.from_stage', 'deal.idle_days',
  'deal.owner.name', 'deal.owner.email', 'tenant.name',
] as const;

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;
type Op = (typeof OPS)[number];

const MAX_DEPTH = 3;

export type Condition = { field: string; op: Op; value: unknown };
export type Group = { all: Node[] } | { any: Node[] };
type Node = Condition | Group;

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
const conditionSchema = z.object({ field: z.string(), op: z.enum(OPS), value: z.union([scalar, z.array(scalar).max(50)]) });
const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.union([conditionSchema, z.object({ all: z.array(nodeSchema).max(20) }), z.object({ any: z.array(nodeSchema).max(20) })]),
);

/** Validates shape, nesting depth (max 3) and that every field is allowed for the trigger. */
export function parseConditions(trigger: TriggerType, raw: unknown): Group {
  const group = z.union([z.object({ all: z.array(nodeSchema).max(20) }), z.object({ any: z.array(nodeSchema).max(20) })]).parse(raw ?? { all: [] });
  const allowed = TRIGGERS[trigger].fields as Record<string, string>;
  const walk = (n: Node, depth: number) => {
    if (depth > MAX_DEPTH) throw new z.ZodError([{ code: 'custom', path: ['conditions'], message: `Nesting deeper than ${MAX_DEPTH}`, input: n }]);
    if ('field' in n) {
      if (!allowed[n.field]) throw new z.ZodError([{ code: 'custom', path: ['conditions', n.field], message: `Field not allowed for ${trigger}`, input: n.field }]);
      return;
    }
    for (const c of 'all' in n ? n.all : n.any) walk(c, depth + 1);
  };
  walk(group, 1);
  return group;
}

export function get(ctx: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx);
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

export function check(c: Condition, ctx: unknown): boolean {
  const actual = get(ctx, c.field);
  switch (c.op) {
    case 'eq': return norm(actual) === norm(c.value);
    case 'neq': return norm(actual) !== norm(c.value);
    case 'gt': return num(actual) > num(c.value);
    case 'gte': return num(actual) >= num(c.value);
    case 'lt': return num(actual) < num(c.value);
    case 'lte': return num(actual) <= num(c.value);
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((a) => norm(a) === norm(c.value))
        : String(actual ?? '').toLowerCase().includes(String(c.value).toLowerCase());
    case 'in': return Array.isArray(c.value) && c.value.some((v) => norm(v) === norm(actual));
  }
}

export interface ConditionResult { field: string; op: Op; expected: unknown; actual: unknown; passed: boolean }

/** Returns whether the group matches plus a flat trace of each leaf, for test runs and the run log. */
export function evaluate(group: Group, ctx: unknown): { matched: boolean; results: ConditionResult[] } {
  const results: ConditionResult[] = [];
  const run = (n: Node): boolean => {
    if ('field' in n) {
      const passed = check(n, ctx);
      results.push({ field: n.field, op: n.op, expected: n.value, actual: get(ctx, n.field), passed });
      return passed;
    }
    // Evaluate every child (no short-circuit) so the trace is complete.
    const outcomes = ('all' in n ? n.all : n.any).map(run);
    return 'all' in n ? outcomes.every(Boolean) : outcomes.length === 0 || outcomes.some(Boolean);
  };
  return { matched: run(group), results };
}

/** Logic-less {{path}} substitution limited to TEMPLATE_VARS. No expressions, no code. */
export function render(template: string, ctx: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    if (!(TEMPLATE_VARS as readonly string[]).includes(path)) return '';
    const v = get(ctx, path);
    return v === undefined || v === null ? '' : String(v);
  });
}

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_task'),
    params: z.object({
      title: z.string().min(1).max(200),
      assignee: z.union([z.enum(['deal_owner', 'contact_owner', 'role:owner']), z.string().regex(/^user:[0-9a-f-]{36}$/)]).default('deal_owner'),
      due_in_hours: z.number().int().min(0).max(24 * 90).default(24),
    }),
  }),
  z.object({
    type: z.literal('send_email'),
    params: z.object({
      to: z.string().min(1).max(200),
      template: z.enum(['high_value_deal', 'follow_up', 'welcome', 'custom']),
      subject: z.string().max(200).optional(),
      body: z.string().max(5000).optional(),
    }),
  }),
  z.object({
    type: z.literal('webhook'),
    params: z.object({ url: z.url().max(500).refine((u) => u.startsWith('https://'), 'Webhooks must use https') }),
  }),
]);
export type Action = z.infer<typeof actionSchema>;
export const actionsSchema = z.array(actionSchema).min(1).max(10);

export const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  triggerType: z.enum(triggerTypes),
  conditions: z.unknown(),
  actions: z.unknown(),
  enabled: z.boolean().optional(),
  templateKey: z.string().max(60).optional(),
});

export function parseRule(raw: unknown) {
  const r = ruleInput.parse(raw);
  return { ...r, conditions: parseConditions(r.triggerType, r.conditions), actions: actionsSchema.parse(r.actions) };
}

export const EMAIL_TEMPLATES: Record<string, { subject: string; body: string }> = {
  high_value_deal: {
    subject: 'High-value deal: {{deal.title}} moved to {{deal.stage}}',
    body: '{{deal.title}} ({{deal.currency}} {{deal.value}}) just moved to {{deal.stage}}.\n\nA review task has been created for you.',
  },
  follow_up: {
    subject: 'Time to follow up: {{deal.title}}',
    body: '{{deal.title}} has not moved for a while. A quick check-in with {{contact.name}} keeps it warm.',
  },
  welcome: {
    subject: 'Thanks for reaching out, {{contact.name}}',
    body: 'Hi {{contact.name}},\n\nThanks for contacting {{tenant.name}}. We will reply within one working day.',
  },
};

/** One-click starting points shown on the Templates page. */
export const RULE_TEMPLATES = [
  {
    key: 'high_value_proposal', category: 'Deals', title: 'High-value proposal',
    desc: 'When a deal over 50,000 reaches Proposal, give the owner a review task and an email.',
    rule: {
      name: 'High-value proposal', triggerType: 'deal.stage_changed' as const,
      conditions: { all: [{ field: 'deal.value', op: 'gt', value: 50000 }, { field: 'deal.stage', op: 'eq', value: 'proposal' }] },
      actions: [
        { type: 'create_task', params: { title: 'Review {{deal.title}}', assignee: 'deal_owner', due_in_hours: 24 } },
        { type: 'send_email', params: { to: '{{deal.owner.email}}', template: 'high_value_deal' } },
      ],
    },
  },
  {
    key: 'new_lead_welcome', category: 'Leads', title: 'New lead welcome',
    desc: 'Email every new lead a thank-you and give the owner a call task for tomorrow.',
    rule: {
      name: 'New lead welcome', triggerType: 'lead.created' as const,
      conditions: { all: [{ field: 'contact.email', op: 'contains', value: '@' }] },
      actions: [
        { type: 'send_email', params: { to: '{{contact.email}}', template: 'welcome' } },
        { type: 'create_task', params: { title: 'Call {{contact.name}}', assignee: 'contact_owner', due_in_hours: 24 } },
      ],
    },
  },
  {
    key: 'hot_lead_fast', category: 'Leads', title: 'Call hot leads fast',
    desc: 'Leads from the website form get a call task due within 1 hour.',
    rule: {
      name: 'Call hot leads fast', triggerType: 'lead.created' as const,
      conditions: { all: [{ field: 'contact.source', op: 'contains', value: 'website' }] },
      actions: [{ type: 'create_task', params: { title: 'Call {{contact.name}} now', assignee: 'contact_owner', due_in_hours: 1 } }],
    },
  },
  {
    key: 'won_handover', category: 'Deals', title: 'Won deal handover',
    desc: 'When a deal is won, create a kick-off task for the owner.',
    rule: {
      name: 'Won deal handover', triggerType: 'deal.stage_changed' as const,
      conditions: { all: [{ field: 'deal.stage', op: 'eq', value: 'won' }] },
      actions: [{ type: 'create_task', params: { title: 'Kick-off call for {{deal.title}}', assignee: 'deal_owner', due_in_hours: 48 } }],
    },
  },
  {
    key: 'quiet_deal_nudge', category: 'Follow-up', title: 'Nudge quiet deals',
    desc: 'When a deal sits in one stage for 7 days, remind the owner to follow up.',
    rule: {
      name: 'Nudge quiet deals', triggerType: 'deal.idle' as const,
      conditions: { all: [] },
      actions: [
        { type: 'create_task', params: { title: 'Follow up on {{deal.title}}', assignee: 'deal_owner', due_in_hours: 4 } },
        { type: 'send_email', params: { to: '{{deal.owner.email}}', template: 'follow_up' } },
      ],
    },
  },
  {
    key: 'negotiation_alert', category: 'Deals', title: 'Negotiation alert for owners',
    desc: 'Tell the workspace owner whenever a deal enters Negotiation.',
    rule: {
      name: 'Negotiation alert', triggerType: 'deal.stage_changed' as const,
      conditions: { all: [{ field: 'deal.stage', op: 'eq', value: 'negotiation' }] },
      actions: [{ type: 'create_task', params: { title: 'Check pricing on {{deal.title}}', assignee: 'role:owner', due_in_hours: 24 } }],
    },
  },
];
