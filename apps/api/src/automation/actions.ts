import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Db, Tx } from '../db';
import { MAIL_FROM, mailer } from '../infra';
import { Action, EMAIL_TEMPLATES, get, render } from './engine';

export interface RunContext {
  db: Db;
  tenantId: string;
  runId: string;
  ruleId: string;
  ruleName: string;
  actionIndex: number;
  payload: unknown;
  signal: AbortSignal;
  /** Set for database-only actions: run inside the caller's transaction (with the step bookkeeping). */
  tx?: Tx;
}

/** Validation errors, 4xx, bad addresses: retrying cannot help, so fail the run now. */
export class NonRetryableError extends Error {}

export interface ActionHandler<P> {
  type: string;
  validate(params: unknown): P;
  execute(ctx: RunContext, params: P): Promise<Record<string, unknown>>;
}

type Params<T extends Action['type']> = Extract<Action, { type: T }>['params'];
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const createTask: ActionHandler<Params<'create_task'>> = {
  type: 'create_task',
  validate: (p) => p as Params<'create_task'>,
  async execute(ctx, p) {
    const dealId = str(get(ctx.payload, 'deal.id'));
    const contactId = str(get(ctx.payload, 'contact.id'));
    const title = render(p.title, ctx.payload).slice(0, 200) || 'Follow up';
    // Same key on every retry of this step, so a retry finds the task instead of making a second one.
    const idempotencyKey = `${ctx.runId}:${ctx.actionIndex}`;

    const work = async (tx: Tx) => {
      const existing = await tx.task.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey } });
      if (existing) return { taskId: existing.id, title: existing.title, deduplicated: true };

      let assigneeId: string | undefined;
      if (p.assignee === 'deal_owner') assigneeId = str(get(ctx.payload, 'deal.owner.id'));
      else if (p.assignee === 'contact_owner') assigneeId = str(get(ctx.payload, 'contact.owner.id')) ?? str(get(ctx.payload, 'deal.owner.id'));
      else if (p.assignee === 'role:owner')
        assigneeId = (await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, role: 'owner' }, orderBy: { createdAt: 'asc' } }))?.userId;
      else {
        // RLS scopes this lookup: a rule can only assign to members of its own tenant.
        const m = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: p.assignee.slice(5) } });
        if (!m) throw new NonRetryableError('Assignee is not a member of this workspace');
        assigneeId = m.userId;
      }

      const task = await tx.task.create({
        data: {
          tenantId: ctx.tenantId, title, assigneeId, dealId, contactId: contactId ?? undefined,
          dueAt: new Date(Date.now() + p.due_in_hours * 3_600_000), createdByRuleId: ctx.ruleId, idempotencyKey,
        },
      });
      await tx.activity.create({
        data: { tenantId: ctx.tenantId, type: 'automation', dealId, contactId, note: `Rule “${ctx.ruleName}” created task “${title}”` },
      });
      return { taskId: task.id, title, assigneeId: assigneeId ?? null };
    };
    return ctx.tx ? work(ctx.tx) : ctx.db.withTenant(ctx.tenantId, work);
  },
};

const sendEmail: ActionHandler<Params<'send_email'>> = {
  type: 'send_email',
  validate: (p) => p as Params<'send_email'>,
  async execute(ctx, p) {
    const to = render(p.to, ctx.payload).trim();
    if (!z.email().safeParse(to).success) throw new NonRetryableError(`No valid recipient (“${p.to}” rendered to “${to}”)`);
    const t = p.template === 'custom' ? { subject: p.subject ?? '', body: p.body ?? '' } : EMAIL_TEMPLATES[p.template];
    const subject = render(t.subject, ctx.payload) || '(no subject)';
    // Deterministic Message-ID: providers that dedupe on it drop a retried duplicate.
    const messageId = `<${ctx.runId}.${ctx.actionIndex}@relaycrm>`;
    await mailer().sendMail({ from: MAIL_FROM, to, subject, text: render(t.body, ctx.payload), messageId });

    const dealId = str(get(ctx.payload, 'deal.id'));
    const contactId = str(get(ctx.payload, 'contact.id'));
    await ctx.db.withTenant(ctx.tenantId, (tx) =>
      tx.activity.create({ data: { tenantId: ctx.tenantId, type: 'email', dealId, contactId, note: `Rule “${ctx.ruleName}” emailed ${to}: ${subject}` } }),
    );
    return { to, subject, messageId };
  },
};

function isPrivate(ip: string) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const webhook: ActionHandler<Params<'webhook'>> = {
  type: 'webhook',
  validate: (p) => p as Params<'webhook'>,
  async execute(ctx, p) {
    const url = new URL(p.url);
    // SSRF guard: https only, and the host must not resolve to a private address.
    // ponytail: resolve-then-fetch can be raced by DNS rebinding; pin the resolved IP
    // with a custom undici dispatcher if webhooks go to untrusted tenants at scale.
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new NonRetryableError('Webhook host is private or does not resolve');
    const body = JSON.stringify({ runId: ctx.runId, ruleId: ctx.ruleId, event: ctx.payload });
    const sig = createHmac('sha256', process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret').update(body).digest('hex');
    const res = await fetch(url, {
      method: 'POST', body, redirect: 'error', signal: ctx.signal,
      headers: { 'content-type': 'application/json', 'x-relaycrm-signature': `sha256=${sig}`, 'idempotency-key': `${ctx.runId}:${ctx.actionIndex}` },
    });
    if (res.status >= 400 && res.status < 500) throw new NonRetryableError(`Webhook answered ${res.status}`);
    if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
    return { status: res.status };
  },
};

// Adding an action = adding one handler above and listing it here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are validated by actionSchema before dispatch
export const HANDLERS: Record<Action['type'], ActionHandler<any>> = {
  create_task: createTask,
  send_email: sendEmail,
  webhook,
};

export const ACTION_TIMEOUT_MS = 10_000;

/** Runs one action with a hard timeout. A timeout counts as transient (retryable). */
export async function runAction(ctx: Omit<RunContext, 'signal'>, action: Action) {
  const handler = HANDLERS[action.type];
  const signal = AbortSignal.timeout(ACTION_TIMEOUT_MS);
  const timeout = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error(`Timed out after ${ACTION_TIMEOUT_MS / 1000} s`)), { once: true }),
  );
  return Promise.race([handler.execute({ ...ctx, signal }, handler.validate(action.params)), timeout]);
}
