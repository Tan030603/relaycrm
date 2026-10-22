import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { askClaude } from '../ai';
import { AuthGuard, CurrentSession, Session, ownerOnly } from '../auth/session';
import { Db, Tx } from '../db';
import type { Prisma } from '../generated/prisma/client';
import { label } from '../deals.controller';
import { audit, emit, invalidateRules } from '../infra';
import {
  Action, EMAIL_TEMPLATES, Group, OPS, RULE_TEMPLATES, TEMPLATE_VARS, TRIGGERS, TriggerType,
  evaluate, parseRule, render, ruleInput, triggerTypes,
} from './engine';

const runsQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'retrying']).optional(),
  ruleId: z.uuid().optional(),
  // Always a time window: with monthly partitions this touches one or two partitions.
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
});
const testBody = z.object({ rule: z.unknown().optional(), payload: z.record(z.string(), z.unknown()).optional() });

/** Sample payloads for test runs when the workspace has no real event of that type yet. */
const SAMPLES: Record<TriggerType, Record<string, unknown>> = {
  'lead.created': { tenant: { name: 'Your workspace' }, contact: { name: 'Priya Nair', email: 'priya@summitfoods.example', company: 'Summit Foods', source: 'Website form · Contact us', tags: [], owner: null } },
  'deal.stage_changed': { tenant: { name: 'Your workspace' }, deal: { title: 'ERP integration', value: 64000, currency: 'USD', stage: 'proposal', from_stage: 'qualified', owner: null }, contact: { name: 'Priya Nair', company: 'Summit Foods' } },
  'deal.idle': { tenant: { name: 'Your workspace' }, deal: { title: 'ERP integration', value: 64000, currency: 'USD', stage: 'proposal', idle_days: 7, owner: null }, contact: { name: 'Priya Nair', company: 'Summit Foods' } },
};

function describeAction(a: Action, payload: unknown) {
  switch (a.type) {
    case 'create_task':
      return { type: a.type, summary: `Create task “${render(a.params.title, payload)}”`, detail: `for ${a.params.assignee.replace('_', ' ')}, due in ${a.params.due_in_hours} h` };
    case 'send_email': {
      const t = a.params.template === 'custom' ? { subject: a.params.subject ?? '' } : EMAIL_TEMPLATES[a.params.template];
      return { type: a.type, summary: `Email “${render(t.subject, payload)}”`, detail: `to ${render(a.params.to, payload) || '(no recipient)'}` };
    }
    case 'webhook':
      return { type: a.type, summary: 'Call webhook', detail: a.params.url };
  }
}

/** One-line description of what triggered the run, e.g. "ERP integration → Proposal". */
function eventSummary(payload: unknown) {
  const p = (payload ?? {}) as { deal?: { title?: string; stage?: string; idle_days?: number }; contact?: { name?: string; company?: string } };
  if (p.deal?.title) return p.deal.idle_days ? `${p.deal.title} · quiet ${p.deal.idle_days} days` : `${p.deal.title} → ${label(p.deal.stage ?? '')}`;
  if (p.contact?.name) return `New lead: ${p.contact.name}${p.contact.company ? ` (${p.contact.company})` : ''}`;
  return null;
}

const runOut = <T extends { status: string; error: string | null; ruleSnapshot: unknown; payload?: unknown }>(r: T) => ({
  ...r,
  eventSummary: eventSummary(r.payload),
  status: r.status === 'queued' && r.error ? 'retrying' : r.status,
  rule: (r.ruleSnapshot as { name?: string }).name,
});

@Controller('automation')
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(private readonly db: Db) {}

  /** Everything the rule builder needs: triggers + their fields, operators, variables, email templates. */
  @Get('catalog')
  catalog() {
    return {
      triggers: Object.entries(TRIGGERS).map(([type, t]) => ({ type, label: t.label, fields: t.fields })),
      ops: OPS, variables: TEMPLATE_VARS,
      emailTemplates: Object.entries(EMAIL_TEMPLATES).map(([key, t]) => ({ key, subject: t.subject })),
    };
  }

  @Get('templates')
  async templates(@CurrentSession() s: Session) {
    const used = await this.db.withTenant(s.tenantId, (tx) =>
      tx.automationRule.findMany({ where: { tenantId: s.tenantId, templateKey: { not: null } }, select: { id: true, templateKey: true, enabled: true } }),
    );
    return RULE_TEMPLATES.map((t) => ({ ...t, installed: used.find((u) => u.templateKey === t.key) ?? null }));
  }

  @Get('rules')
  async rules(@CurrentSession() s: Session) {
    return this.db.withTenant(s.tenantId, async (tx) => {
      const rules = await tx.automationRule.findMany({ where: { tenantId: s.tenantId }, orderBy: { id: 'desc' }, take: 200 });
      const stats = await tx.automationRun.groupBy({
        by: ['ruleId', 'status'], where: { tenantId: s.tenantId, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: true,
      });
      return rules.map((r) => ({
        ...r,
        runs7d: Object.fromEntries(stats.filter((x) => x.ruleId === r.id).map((x) => [x.status, x._count])),
      }));
    });
  }

  @Get('rules/:id')
  async rule(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    const rule = await this.db.withTenant(s.tenantId, (tx) => tx.automationRule.findFirst({ where: { id, tenantId: s.tenantId } }));
    if (!rule) throw new NotFoundException('Rule not found');
    return rule;
  }

  @Post('rules')
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    ownerOnly(s);
    const r = parseRule(raw);
    const rule = await this.db.withTenant(s.tenantId, async (tx) => {
      const rule = await tx.automationRule.create({
        data: { ...r, conditions: r.conditions as Prisma.InputJsonValue, actions: r.actions as Prisma.InputJsonValue, tenantId: s.tenantId, createdBy: s.userId, updatedBy: s.userId },
      });
      await audit(tx, s.tenantId, s.userId, 'rule.created', 'automation_rule', rule.id, { name: rule.name });
      return rule;
    });
    await invalidateRules(s.tenantId, rule.triggerType);
    return rule;
  }

  /** One click on the Templates page: installs the template as an enabled rule. */
  @Post('templates/:key/install')
  async install(@CurrentSession() s: Session, @Param('key') key: string) {
    const t = RULE_TEMPLATES.find((x) => x.key === key);
    if (!t) throw new NotFoundException('Template not found');
    return this.create(s, { ...t.rule, description: t.desc, templateKey: t.key });
  }

  /** Edits bump the version; past runs keep the snapshot of the version they ran. */
  @Patch('rules/:id')
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    ownerOnly(s);
    const patch = ruleInput.partial().parse(raw);
    const { before, rule } = await this.db.withTenant(s.tenantId, async (tx) => {
      const before = await tx.automationRule.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!before) throw new NotFoundException('Rule not found');
      const merged = parseRule({
        name: patch.name ?? before.name, description: patch.description ?? before.description ?? undefined,
        triggerType: patch.triggerType ?? before.triggerType, conditions: patch.conditions ?? before.conditions,
        actions: patch.actions ?? before.actions, enabled: patch.enabled ?? before.enabled,
      });
      const rule = await tx.automationRule.update({
        where: { id },
        data: { ...merged, conditions: merged.conditions as Prisma.InputJsonValue, actions: merged.actions as Prisma.InputJsonValue, version: { increment: 1 }, updatedBy: s.userId },
      });
      await audit(tx, s.tenantId, s.userId, 'rule.updated', 'automation_rule', id, { version: rule.version });
      return { before, rule };
    });
    await invalidateRules(s.tenantId, before.triggerType);
    if (rule.triggerType !== before.triggerType) await invalidateRules(s.tenantId, rule.triggerType);
    return rule;
  }

  @Post('rules/:id/enable')
  @HttpCode(200)
  enable(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    return this.setEnabled(s, id, true);
  }

  @Post('rules/:id/disable')
  @HttpCode(200)
  disable(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    return this.setEnabled(s, id, false);
  }

  private async setEnabled(s: Session, id: string, enabled: boolean) {
    ownerOnly(s);
    const rule = await this.db.withTenant(s.tenantId, async (tx) => {
      const r = await tx.automationRule.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!r) throw new NotFoundException('Rule not found');
      await audit(tx, s.tenantId, s.userId, enabled ? 'rule.enabled' : 'rule.disabled', 'automation_rule', id);
      return tx.automationRule.update({ where: { id }, data: { enabled, updatedBy: s.userId } });
    });
    await invalidateRules(s.tenantId, rule.triggerType);
    return rule;
  }

  /**
   * Dry run: evaluates conditions and renders the planned actions against the latest
   * real event of that type (or a sample). Writes nothing, sends nothing.
   */
  @Post('rules/test')
  @HttpCode(200)
  async testDraft(@CurrentSession() s: Session, @Body() raw: unknown) {
    const body = testBody.parse(raw);
    return this.db.withTenant(s.tenantId, (tx) => this.dryRun(tx, s, parseRule(body.rule), body.payload));
  }

  @Post('rules/:id/test')
  @HttpCode(200)
  async testSaved(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const body = testBody.parse(raw ?? {});
    return this.db.withTenant(s.tenantId, async (tx) => {
      const r = await tx.automationRule.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!r) throw new NotFoundException('Rule not found');
      return this.dryRun(tx, s, parseRule({ ...r, description: r.description ?? undefined, templateKey: r.templateKey ?? undefined }), body.payload);
    });
  }

  private async dryRun(tx: Tx, s: Session, rule: { triggerType: TriggerType; conditions: Group; actions: Action[] }, payload?: Record<string, unknown>) {
    let source = 'provided';
    let sample: unknown = payload;
    if (!sample) {
      const ev = await tx.domainEvent.findFirst({ where: { tenantId: s.tenantId, type: rule.triggerType }, orderBy: { id: 'desc' } });
      sample = ev?.payload ?? SAMPLES[rule.triggerType];
      source = ev ? 'latest_event' : 'sample';
    }
    const { matched, results } = evaluate(rule.conditions, sample);
    return { source, payload: sample, matched, conditions: results, actions: matched ? rule.actions.map((a) => describeAction(a, sample)) : [] };
  }

  /** "Describe the rule in plain English": Claude drafts a rule, which is validated like any other and NOT saved. */
  @Post('rules/generate')
  @HttpCode(200)
  async generate(@CurrentSession() s: Session, @Body() raw: unknown) {
    ownerOnly(s);
    const { text } = z.object({ text: z.string().trim().min(5).max(1000) }).parse(raw);
    const draft = await askClaude<unknown>({
      system:
        'You turn plain-English automation requests into a JSON rule for a CRM. Use ONLY the triggers, fields, operators, actions and variables listed. ' +
        `Triggers and allowed condition fields: ${JSON.stringify(Object.fromEntries(Object.entries(TRIGGERS).map(([k, v]) => [k, Object.keys(v.fields)])))}. ` +
        `Operators: ${OPS.join(', ')}. Stages: new, qualified, proposal, negotiation, won. ` +
        'Actions: create_task {title, assignee: deal_owner|contact_owner|role:owner, due_in_hours}, send_email {to, template: high_value_deal|follow_up|welcome|custom, subject?, body?}. ' +
        `Template variables in {{ }}: ${TEMPLATE_VARS.join(', ')}.`,
      prompt: text,
      tool: 'rule',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          triggerType: { type: 'string', enum: triggerTypes },
          conditions: { type: 'object', description: '{"all": [{"field","op","value"}]} or {"any": [...]}' },
          actions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, params: { type: 'object' } }, required: ['type', 'params'] } },
        },
        required: ['name', 'triggerType', 'conditions', 'actions'],
      },
    });
    try {
      return { rule: parseRule(draft) };
    } catch {
      throw new BadRequestException('AI could not turn that into a valid rule; try rephrasing');
    }
  }

  @Get('runs')
  async runs(@CurrentSession() s: Session, @Query() raw: unknown) {
    const q = runsQuery.parse(raw);
    const since = new Date(Date.now() - q.hours * 3_600_000);
    const statusFilter =
      q.status === 'retrying' ? { status: 'queued' as const, error: { not: null } } : q.status ? { status: q.status } : { status: { not: 'skipped' as const } };
    return this.db.withTenantRead(s.tenantId, async (tx) => {
      const where = { tenantId: s.tenantId, createdAt: { gte: since }, ...(q.ruleId && { ruleId: q.ruleId }) };
      const [rows, counts] = await Promise.all([
        tx.automationRun.findMany({
          where: { ...where, ...statusFilter, ...(q.cursor && { id: { lt: q.cursor } }) },
          orderBy: { id: 'desc' }, take: q.limit + 1,
          select: { id: true, status: true, error: true, ruleId: true, ruleVersion: true, ruleSnapshot: true, payload: true, eventType: true, attempt: true, createdAt: true, finishedAt: true },
        }),
        tx.automationRun.groupBy({ by: ['status'], where, _count: true }),
      ]);
      const data = rows.slice(0, q.limit).map(runOut);
      return { data, nextCursor: rows.length > q.limit ? data.at(-1)!.id : null, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
    });
  }

  @Get('runs/:id')
  async run(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenantRead(s.tenantId, (tx) =>
      tx.automationRun.findFirst({ where: { id, tenantId: s.tenantId }, include: { steps: { orderBy: { actionIndex: 'asc' } } } }),
    );
    if (!r) throw new NotFoundException('Run not found');
    return runOut(r);
  }

  /** Manual retry from the dead-letter state. Goes through the outbox like everything else. */
  @Post('runs/:id/retry')
  @HttpCode(202)
  async retry(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    ownerOnly(s);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const { count } = await tx.automationRun.updateMany({ where: { id, tenantId: s.tenantId, status: 'failed' }, data: { status: 'queued', error: null, finishedAt: null } });
      if (!count) throw new BadRequestException('Only failed runs can be retried');
      await emit(tx, { tenantId: s.tenantId, type: 'automation.retry', aggregateType: 'run', aggregateId: id, payload: { runId: id } });
      await audit(tx, s.tenantId, s.userId, 'run.retried', 'automation_run', id);
      return { id, status: 'queued' };
    });
  }
}

