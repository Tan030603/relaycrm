import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, CurrentSession, Session, ownsOrOwner } from './auth/session';
import { listQuery } from './contacts.controller';
import { Db } from './db';
import { Idempotent } from './idempotency';

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  dealId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
});
const patchBody = createBody.partial().extend({ status: z.enum(['open', 'done']).optional() });
const taskQuery = listQuery.extend({ status: z.enum(['open', 'done']).default('open'), mine: z.stringbool().default(false) });

@Controller('tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@CurrentSession() s: Session, @Query() raw: unknown) {
    const { cursor, limit, status, mine } = taskQuery.parse(raw);
    const rows = await this.db.withTenant(s.tenantId, (tx) =>
      tx.task.findMany({
        where: { tenantId: s.tenantId, status, ...(mine && { assigneeId: s.userId }), ...(cursor && { id: { lt: cursor } }) },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
    const data = rows.slice(0, limit);
    return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
  }

  @Post()
  @UseInterceptors(Idempotent)
  async create(@CurrentSession() s: Session, @Body() raw: unknown) {
    const body = createBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      if (body.assigneeId && !(await tx.membership.findFirst({ where: { tenantId: s.tenantId, userId: body.assigneeId } })))
        throw new BadRequestException('Assignee must be a workspace member');
      // RLS makes a deal/contact id from another tenant invisible, so the FK check below fails closed.
      if (body.dealId && !(await tx.deal.findFirst({ where: { id: body.dealId } }))) throw new BadRequestException('Deal not found');
      return tx.task.create({ data: { ...body, assigneeId: body.assigneeId ?? s.userId, tenantId: s.tenantId } });
    });
  }

  @Patch(':id')
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const body = patchBody.parse(raw);
    return this.db.withTenant(s.tenantId, async (tx) => {
      const t = await tx.task.findFirst({ where: { id, tenantId: s.tenantId } });
      if (!t) throw new NotFoundException('Task not found');
      ownsOrOwner(s, t.assigneeId);
      return tx.task.update({ where: { id }, data: body });
    });
  }
}
