import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession, Session } from './auth/session';
import { Db } from './db';
import { dealOut } from './deals.controller';

const DAY = 86_400_000;

/** The home page in one round trip: my tasks, quiet deals, KPIs, live feed, 7-day run chart. */
@Controller('today')
@UseGuards(AuthGuard)
export class TodayController {
  constructor(private readonly db: Db) {}

  @Get()
  async today(@CurrentSession() s: Session) {
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const t = s.tenantId;

    return this.db.withTenantRead(t, async (tx) => {
      const [tasks, dueCount, dueByRule, quiet, pipeline, won, runs24, feed, chart] = await Promise.all([
        tx.task.findMany({ where: { tenantId: t, assigneeId: s.userId, status: 'open', dueAt: { lte: endOfDay } }, orderBy: { dueAt: 'asc' }, take: 8 }),
        tx.task.count({ where: { tenantId: t, assigneeId: s.userId, status: 'open', dueAt: { lte: endOfDay } } }),
        tx.task.count({ where: { tenantId: t, assigneeId: s.userId, status: 'open', dueAt: { lte: endOfDay }, createdByRuleId: { not: null } } }),
        tx.deal.findMany({
          where: { tenantId: t, stage: { not: 'won' }, stageChangedAt: { lt: new Date(now.getTime() - 7 * DAY) } },
          orderBy: { stageChangedAt: 'asc' }, take: 5, include: { contact: { select: { name: true, company: true } } },
        }),
        tx.deal.aggregate({ where: { tenantId: t, stage: { not: 'won' } }, _sum: { value: true }, _count: true }),
        tx.deal.aggregate({ where: { tenantId: t, stage: 'won', stageChangedAt: { gte: monthStart } }, _sum: { value: true }, _count: true }),
        tx.automationRun.groupBy({ by: ['status'], where: { tenantId: t, createdAt: { gte: new Date(now.getTime() - DAY) }, status: { not: 'skipped' } }, _count: true }),
        tx.activity.findMany({ where: { tenantId: t }, orderBy: { occurredAt: 'desc' }, take: 8 }),
        tx.$queryRaw<{ day: Date; total: bigint; ok: bigint }[]>`
          SELECT date_trunc('day', created_at) AS day, count(*) AS total, count(*) FILTER (WHERE status = 'succeeded') AS ok
            FROM automation_runs
           WHERE tenant_id = ${t}::uuid AND created_at >= now() - interval '7 days' AND status <> 'skipped'
           GROUP BY 1 ORDER BY 1`,
      ]);
      const movedToday = await tx.activity.count({ where: { tenantId: t, type: 'stage_changed', occurredAt: { gte: new Date(now.toDateString()) } } });
      const runCount = (st: string) => runs24.find((r) => r.status === st)?._count ?? 0;
      return {
        kpis: {
          pipeline: { value: Number(pipeline._sum.value ?? 0), deals: pipeline._count, movedToday },
          won: { value: Number(won._sum.value ?? 0), deals: won._count },
          tasks: { due: dueCount, fromRules: dueByRule },
          runs: { total: runs24.reduce((n, r) => n + r._count, 0), failed: runCount('failed'), succeeded: runCount('succeeded') },
        },
        tasks,
        quiet: quiet.map((d) => ({ ...dealOut(d), daysQuiet: Math.floor((now.getTime() - d.stageChangedAt.getTime()) / DAY) })),
        feed,
        chart: chart.map((c) => ({ day: c.day, total: Number(c.total), ok: Number(c.ok) })),
      };
    });
  }
}
