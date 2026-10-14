import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, CurrentSession, Session } from './auth/session';
import { Db } from './db';

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional(),
  phone: z.string().trim().max(50).optional(),
  company: z.string().trim().max(200).optional(),
  source: z.string().trim().max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
const listQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

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
    const { cursor, limit } = listQuery.parse(raw);
    const rows = await this.db.withTenant(s.tenantId, (tx) =>
      tx.contact.findMany({
        // tenantId here as well as in RLS: defence in depth, and it helps the planner pick the index.
        where: { tenantId: s.tenantId, ...(cursor && { id: { lt: cursor } }) },
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
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    const body = createBody.parse(raw);
    return this.db.withTenant(s.tenantId, (tx) =>
      tx.contact.create({
        data: { ...body, email: body.email?.toLowerCase(), tenantId: s.tenantId, ownerId: s.userId },
      }),
    );
  }
}
