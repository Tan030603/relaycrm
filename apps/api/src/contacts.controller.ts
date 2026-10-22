import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { contactPayload } from './automation/payloads';
import { AuthGuard, CurrentSession, Session, ownsOrOwner } from './auth/session';
import { Db, Tx } from './db';
import { Idempotent } from './idempotency';
import { emit } from './infra';

const fields = {
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional(),
  phone: z.string().trim().max(50).optional(),
  company: z.string().trim().max(200).optional(),
  source: z.string().trim().max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
};
const createBody = z.object(fields);
// On edit, an empty string clears an optional field.
const clearable = <T extends z.ZodType>(t: T) => z.union([z.literal('').transform(() => null), t.nullable()]).optional();
const patchBody = z.object(fields).partial().extend({
  email: clearable(z.email().max(254)),
  phone: clearable(z.string().trim().max(50)),
  company: clearable(z.string().trim().max(200)),
  ownerId: z.uuid().nullable().optional(),
});
export const listQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const contactQuery = listQuery.extend({ q: z.string().trim().max(100).optional() });

/** Shared by the API and public lead forms: insert + lead.created in one transaction. */
export async function createContact(tx: Tx, tenantId: string, data: z.infer<typeof createBody> & { ownerId?: string | null; formId?: string }) {
  const contact = await tx.contact.create({ data: { ...data, email: data.email?.toLowerCase(), tenantId } });
  await emit(tx, { tenantId, type: 'lead.created', aggregateType: 'contact', aggregateId: contact.id, payload: await contactPayload(tx, contact.id) });
  return contact;
}

@Controller('contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  constructor(private readonly db: Db) {}

  /**
   * Cursor pagination: ids are uuidv7 (time-ordered), so "id < cursor" walks newest
   * to oldest on the (tenant_id, id) index. No OFFSET, no COUNT(*).
   */
  @Get()
  async list(@CurrentSession() s: Session, @Query() raw: unknown) {
    const { cursor, limit, q } = contactQuery.parse(raw);
    const rows = await this.db.withTenant(s.tenantId, (tx) =>
      tx.contact.findMany({
        // tenantId here as well as in RLS: defence in depth, and it helps the planner pick the index.
        where: {
          tenantId: s.tenantId,
          ...(cursor && { id: { lt: cursor } }),
          // ponytail: ILIKE scan within the tenant; add a tsvector/trigram index when tenants pass ~100k contacts.
          ...(q && { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { company: { contains: q, mode: 'insensitive' } }] }),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
    const data = rows.slice(0, limit);
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  @Get(':id')
  async get(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    const contact = await this.db.withTenant(s.tenantId, (tx) => tx.contact.findFirst({ where: { id, tenantId: s.tenantId } }));
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  @Post()
  @UseInterceptors(Idempotent)
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    const body = createBody.parse(raw);
    return this.db.withTenant(s.tenantId, (tx) => createContact(tx, s.tenantId, { ...body, ownerId: s.userId }));
  }

  @Patch(':id')
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const body = patchBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const c = await tx.contact.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!c) throw new NotFoundException('Contact not found');
      ownsOrOwner(s, c.ownerId);
      return tx.contact.update({ where: { id }, data: { ...body, email: body.email?.toLowerCase() } });
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.withTenant(s.tenantId, async (tx) => {
      const c = await tx.contact.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!c) throw new NotFoundException('Contact not found');
      ownsOrOwner(s, c.ownerId);
      await tx.contact.delete({ where: { id } });
    });
  }
}
