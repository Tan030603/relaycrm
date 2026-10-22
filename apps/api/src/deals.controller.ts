import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { aiEnabled, askClaude } from './ai';
import { dealPayload } from './automation/payloads';
import { AuthGuard, CurrentSession, Session, ownsOrOwner } from './auth/session';
import { listQuery } from './contacts.controller';
import { Db, Tx } from './db';
import type { Deal } from './generated/prisma/client';
import { Idempotent } from './idempotency';
import { emit } from './infra';

export const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won'] as const;
type Stage = (typeof STAGES)[number];
const BOARD_PAGE = 20;

const fields = {
  title: z.string().trim().min(1).max(200),
  value: z.coerce.number().min(0).max(1e12).default(0),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  contactId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  expectedCloseDate: z.coerce.date().nullable().optional(),
};
const createBody = z.object({ ...fields, stage: z.enum(STAGES).default('new') });
const patchBody = z.object(fields).partial();
const moveBody = z.object({ stage: z.enum(STAGES) });
const activityBody = z.object({ type: z.enum(['note', 'call', 'email', 'meeting']).default('note'), note: z.string().trim().min(1).max(5000) });
const stageQuery = listQuery.extend({ stage: z.enum(STAGES) });

export const dealOut = (d: Deal) => ({ ...d, value: Number(d.value) });

async function assertMember(tx: Tx, tenantId: string, userId: string | null | undefined) {
  if (userId && !(await tx.membership.findFirst({ where: { tenantId, userId } }))) throw new BadRequestException('Owner must be a workspace member');
}

@Controller('deals')
@UseGuards(AuthGuard)
export class DealsController {
  constructor(private readonly db: Db) {}

  /**
   * First page of every column plus per-stage totals. Each column then pages on its own
   * (GET /deals?stage=...) using the (tenant_id, stage, id) index.
   */
  @Get('board')
  async board(@CurrentSession() s: Session) {
    return this.db.withTenantRead(s.tenantId, async (tx) => {
      // ponytail: groupBy counts every open deal of the tenant; fine to ~100k deals per
      // tenant, then keep running totals per stage updated on move.
      const totals = await tx.deal.groupBy({ by: ['stage'], where: { tenantId: s.tenantId }, _count: true, _sum: { value: true } });
      const columns = await Promise.all(
        STAGES.map(async (stage) => {
          const rows = await tx.deal.findMany({
            where: { tenantId: s.tenantId, stage },
            orderBy: { id: 'desc' },
            take: BOARD_PAGE + 1,
            include: { contact: { select: { name: true, company: true } } },
          });
          const t = totals.find((x) => x.stage === stage);
          const deals = rows.slice(0, BOARD_PAGE);
          return {
            stage, count: t?._count ?? 0, total: Number(t?._sum.value ?? 0),
            deals: deals.map(dealOut), nextCursor: rows.length > BOARD_PAGE ? deals.at(-1)!.id : null,
          };
        }),
      );
      // Which deals got a task from a rule: a badge on the card.
      const ids = columns.flatMap((c) => c.deals.map((d) => d.id));
      const ruled = await tx.task.findMany({ where: { tenantId: s.tenantId, dealId: { in: ids }, createdByRuleId: { not: null } }, select: { dealId: true }, distinct: ['dealId'] });
      const ruledSet = new Set(ruled.map((r) => r.dealId));
      return columns.map((c) => ({ ...c, deals: c.deals.map((d) => ({ ...d, ruleTask: ruledSet.has(d.id) })) }));
    });
  }

  @Get()
  async list(@CurrentSession() s: Session, @Query() raw: unknown) {
    const { stage, cursor, limit } = stageQuery.parse(raw);
    const rows = await this.db.withTenant(s.tenantId, (tx) =>
      tx.deal.findMany({
        where: { tenantId: s.tenantId, stage, ...(cursor && { id: { lt: cursor } }) },
        orderBy: { id: 'desc' },
        take: limit + 1,
        include: { contact: { select: { name: true, company: true } } },
      }),
    );
    const data = rows.slice(0, limit).map(dealOut);
    return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
  }

  @Post()
  @UseInterceptors(Idempotent)
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    const body = createBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      await assertMember(tx, s.tenantId, body.ownerId);
      const deal = await tx.deal.create({ data: { ...body, ownerId: body.ownerId ?? s.userId, tenantId: s.tenantId } });
      await tx.activity.create({ data: { tenantId: s.tenantId, type: 'created', dealId: deal.id, contactId: deal.contactId, note: `Deal created in ${deal.stage}`, actorId: s.userId } });
      return dealOut(deal);
    });
  }

  @Get(':id')
  async get(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(s.tenantId, async (tx) => {
      const deal = await tx.deal.findFirst({ where: { id, tenantId: s.tenantId }, include: { contact: true } });
      if (!deal) return null;
      const [owner, tasks, activities, runs] = await Promise.all([
        deal.ownerId ? tx.user.findUnique({ where: { id: deal.ownerId }, select: { id: true, name: true, email: true } }) : null,
        tx.task.findMany({ where: { tenantId: s.tenantId, dealId: id, status: 'open' }, orderBy: { dueAt: 'asc' }, take: 20 }),
        tx.activity.findMany({ where: { tenantId: s.tenantId, dealId: id }, orderBy: { occurredAt: 'desc' }, take: 30 }),
        tx.automationRun.findMany({
          where: { tenantId: s.tenantId, aggregateId: id, status: { not: 'skipped' } },
          orderBy: { id: 'desc' }, take: 10,
          select: { id: true, status: true, ruleSnapshot: true, createdAt: true },
        }),
      ]);
      return {
        ...dealOut(deal), owner, tasks, activities,
        runs: runs.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, rule: (r.ruleSnapshot as { name?: string }).name })),
      };
    });
    if (!r) throw new NotFoundException('Deal not found');
    return r;
  }

  @Patch(':id')
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const body = patchBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const d = await tx.deal.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!d) throw new NotFoundException('Deal not found');
      ownsOrOwner(s, d.ownerId);
      await assertMember(tx, s.tenantId, body.ownerId);
      return dealOut(await tx.deal.update({ where: { id }, data: body }));
    });
  }

  /** Stage change + its domain event in one transaction (outbox). */
  @Post(':id/move')
  async move(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const { stage } = moveBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const d = await tx.deal.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!d) throw new NotFoundException('Deal not found');
      ownsOrOwner(s, d.ownerId);
      if (d.stage === stage) return dealOut(d);
      const deal = await tx.deal.update({ where: { id }, data: { stage, stageChangedAt: new Date() } });
      await tx.activity.create({ data: { tenantId: s.tenantId, type: 'stage_changed', dealId: id, contactId: d.contactId, note: `Moved from ${label(d.stage)} to ${label(stage)}`, actorId: s.userId } });
      await emit(tx, { tenantId: s.tenantId, type: 'deal.stage_changed', aggregateType: 'deal', aggregateId: id, payload: await dealPayload(tx, id, { from_stage: d.stage }) });
      return dealOut(deal);
    });
  }

  @Post(':id/activities')
  async addActivity(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const body = activityBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const d = await tx.deal.findFirst({ where: { id, tenantId: s.tenantId }, select: { contactId: true } });
      if (!d) throw new NotFoundException('Deal not found');
      return tx.activity.create({ data: { tenantId: s.tenantId, type: body.type, note: body.note, dealId: id, contactId: d.contactId, actorId: s.userId } });
    });
  }

  /** AI helper on the deal page: summary, next step and a follow-up email draft. Never sends anything itself. */
  @Post(':id/assist')
  async assist(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    const ctx = await this.db.withTenant(s.tenantId, async (tx) => {
      const d = await tx.deal.findFirst({ where: { id, tenantId: s.tenantId }, include: { contact: true } });
      if (!d) throw new NotFoundException('Deal not found');
      const activities = await tx.activity.findMany({ where: { tenantId: s.tenantId, dealId: id }, orderBy: { occurredAt: 'desc' }, take: 40 });
      const me = await tx.user.findUnique({ where: { id: s.userId }, select: { name: true } });
      return { d, activities, me };
    });
    const { d, activities, me } = ctx;
    const daysInStage = Math.floor((Date.now() - d.stageChangedAt.getTime()) / 86_400_000);
    const contactName = d.contact?.name ?? 'there';

    if (!aiEnabled()) {
      // Deterministic fallback so the page works without an API key.
      return {
        source: 'rules',
        summary: [
          `${d.title} is in ${label(d.stage)} (${d.currency} ${Number(d.value).toLocaleString('en-US')}), ${daysInStage} day(s) in this stage.`,
          `${activities.length} activit${activities.length === 1 ? 'y' : 'ies'} logged${activities[0] ? `; latest: “${activities[0].note.slice(0, 120)}”` : ''}.`,
        ],
        nextStep: daysInStage >= 7 ? `It has been quiet for ${daysInStage} days: check in with ${contactName}.` : `Agree the next step with ${contactName} and log it.`,
        email: {
          subject: `Next steps on ${d.title}`,
          body: `Hi ${contactName.split(' ')[0]},\n\nThanks again for your time. I wanted to check where things stand on ${d.title} and whether anything is blocking a decision.\n\nWould a short call this week help?\n\nBest,\n${me?.name ?? ''}`,
        },
        basedOn: activities.length,
      };
    }

    const timeline = activities.map((a) => `- ${a.occurredAt.toISOString().slice(0, 10)} [${a.type}] ${a.note}`).join('\n') || '(no activities yet)';
    const out = await askClaude<{ summary: string[]; nextStep: string; email: { subject: string; body: string } }>({
      system: 'You are a sales assistant inside a CRM. Be concrete and brief. Use only facts from the deal data; never invent numbers, names or commitments.',
      prompt: `Deal: ${d.title}\nValue: ${d.currency} ${d.value}\nStage: ${label(d.stage)} for ${daysInStage} days\nContact: ${d.contact?.name ?? 'unknown'}${d.contact?.company ? `, ${d.contact.company}` : ''}\nExpected close: ${d.expectedCloseDate?.toISOString().slice(0, 10) ?? 'not set'}\nSales rep: ${me?.name}\n\nTimeline (newest first):\n${timeline}\n\nSummarise the deal in 2-4 short bullet sentences, suggest one next step, and draft a short follow-up email from the rep to the contact.`,
      tool: 'deal_assist',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          nextStep: { type: 'string' },
          email: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
        },
        required: ['summary', 'nextStep', 'email'],
      },
    });
    return { source: 'claude', ...out, basedOn: activities.length };
  }
}

export function label(stage: Stage | string) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
