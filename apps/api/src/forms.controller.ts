import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard, CurrentSession, Session, ownerOnly } from './auth/session';
import { createContact } from './contacts.controller';
import { Db } from './db';
import type { Prisma } from './generated/prisma/client';
import { audit } from './infra';

// Form fields map onto contact columns; anything else is kept as a note.
const FIELD_KEYS = ['name', 'email', 'company', 'phone', 'message'] as const;
const fieldSchema = z.object({ key: z.enum(FIELD_KEYS), label: z.string().trim().min(1).max(80), required: z.boolean().default(false) });
const formBody = z.object({
  name: z.string().trim().min(1).max(100),
  headline: z.string().trim().max(120).optional(),
  enabled: z.boolean().optional(),
  fields: z.array(fieldSchema).min(1).max(10)
    .refine((f) => f.some((x) => x.key === 'name' && x.required), 'Name must be a required field')
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Each field can appear once'),
  assignToId: z.uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

@Controller('forms')
@UseGuards(AuthGuard)
export class FormsController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@CurrentSession() s: Session) {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const forms = await tx.leadForm.findMany({ where: { tenantId: s.tenantId }, orderBy: { id: 'asc' } });
      const subs = await tx.contact.groupBy({ by: ['formId'], where: { tenantId: s.tenantId, formId: { not: null }, createdAt: { gte: weekAgo } }, _count: true });
      const listeners = await tx.automationRule.findMany({ where: { tenantId: s.tenantId, triggerType: 'lead.created', enabled: true }, select: { id: true, name: true } });
      return Promise.all(
        forms.map(async (f) => ({
          ...f,
          submissionsThisWeek: subs.find((x) => x.formId === f.id)?._count ?? 0,
          becameDealsThisWeek: await tx.deal.count({ where: { tenantId: s.tenantId, contact: { formId: f.id, createdAt: { gte: weekAgo } } } }),
          listeners,
        })),
      );
    });
  }

  @Post()
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    ownerOnly(s);
    const body = formBody.parse(raw);
    return this.db.withTenant(s.tenantId, (tx) => tx.leadForm.create({ data: { ...body, fields: body.fields as Prisma.InputJsonValue, tenantId: s.tenantId } }));
  }

  @Patch(':id')
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    ownerOnly(s);
    const body = formBody.partial().parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const f = await tx.leadForm.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!f) throw new NotFoundException('Form not found');
      if (body.assignToId && !(await tx.membership.findFirst({ where: { tenantId: s.tenantId, userId: body.assignToId } }))) throw new BadRequestException('Assignee must be a member');
      await audit(tx, s.tenantId, s.userId, 'form.updated', 'lead_form', id);
      return tx.leadForm.update({ where: { id }, data: { ...body, fields: body.fields as Prisma.InputJsonValue | undefined } });
    });
  }
}

const submitBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional().or(z.literal('').transform(() => undefined)),
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  message: z.string().trim().max(5000).optional(),
  website: z.string().optional(), // honeypot: humans never see this field
});

/**
 * Public, unauthenticated. The tenant id is in the URL (it is not a secret, the form
 * id is unguessable); RLS still scopes every query to that tenant. Rate-limited per IP.
 */
@Controller('public/forms')
@UseGuards(ThrottlerGuard)
export class PublicFormsController {
  constructor(private readonly db: Db) {}

  @Get(':tenantId/:formId')
  async show(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('formId', ParseUUIDPipe) formId: string) {
    const r = await this.db.withTenant(tenantId, async (tx) => {
      const form = await tx.leadForm.findFirst({ where: { id: formId, tenantId, enabled: true }, select: { name: true, headline: true, fields: true } });
      return form && { ...form, tenant: (await tx.tenant.findFirstOrThrow({ select: { name: true } })).name };
    });
    if (!r) throw new NotFoundException('Form not found');
    return r;
  }

  @Post(':tenantId/:formId')
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async submit(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('formId', ParseUUIDPipe) formId: string, @Body() raw: unknown) {
    const body = submitBody.parse(raw);
    if (body.website) return { ok: true }; // bot: pretend success, store nothing
    await this.db.withTenant(tenantId, async (tx) => {
      const form = await tx.leadForm.findFirst({ where: { id: formId, tenantId, enabled: true } });
      if (!form) throw new NotFoundException('Form not found');
      const fields = form.fields as { key: string; required: boolean }[];
      for (const f of fields) if (f.required && !body[f.key as keyof typeof body]) throw new BadRequestException(`${f.key} is required`);

      // "Take turns": round-robin over members by how many form leads each already has.
      let ownerId = form.assignToId;
      if (!ownerId) {
        const members = await tx.membership.findMany({ where: { tenantId }, select: { userId: true }, orderBy: { createdAt: 'asc' } });
        const n = await tx.contact.count({ where: { tenantId, formId } });
        ownerId = members[n % members.length]?.userId ?? null;
      }
      const contact = await createContact(tx, tenantId, {
        name: body.name, email: body.email, company: body.company, phone: body.phone,
        source: `Website form · ${form.name}`, tags: form.tags, ownerId, formId,
      });
      if (body.message) await tx.activity.create({ data: { tenantId, type: 'form', contactId: contact.id, note: body.message } });
    });
    return { ok: true };
  }
}
