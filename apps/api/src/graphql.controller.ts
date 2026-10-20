import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { buildSchema, graphql } from 'graphql';
import { z } from 'zod';
import { AuthGuard, CurrentSession, Session } from './auth/session';
import { Db } from './db';

// Read-only GraphQL over run history: the UI can fetch a run with its steps and rule
// in one request and pick exactly the fields it shows. Writes stay on REST.
const schema = buildSchema(`
  enum RunStatus { queued running succeeded failed skipped }
  type Step { actionIndex: Int!, actionType: String!, status: String!, error: String, tries: Int!, input: String, output: String }
  type Run {
    id: ID!, status: RunStatus!, ruleId: ID!, ruleName: String, ruleVersion: Int!, eventType: String!,
    attempt: Int!, error: String, createdAt: String!, finishedAt: String, steps: [Step!]!
  }
  type RunPage { nodes: [Run!]!, nextCursor: ID }
  type Query {
    runs(status: RunStatus, ruleId: ID, first: Int = 20, after: ID): RunPage!
    run(id: ID!): Run
  }
`);

const body = z.object({ query: z.string().max(10_000), variables: z.record(z.string(), z.unknown()).optional(), operationName: z.string().optional() });
type Row = Awaited<ReturnType<Db['automationRun']['findFirst']>> & { steps?: { input: unknown; output: unknown }[] };

@Controller('graphql')
@UseGuards(AuthGuard)
export class GraphqlController {
  constructor(private readonly db: Db) {}

  @Post()
  @HttpCode(200)
  async query(@CurrentSession() s: Session, @Body() raw: unknown) {
    const { query, variables, operationName } = body.parse(raw);
    const shape = (r: NonNullable<Row>) => ({
      ...r,
      ruleName: (r.ruleSnapshot as { name?: string }).name,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString(),
      // Steps load lazily: only when the query asks for them.
      steps: () =>
        this.db.withTenantRead(s.tenantId, (tx) => tx.automationRunStep.findMany({ where: { runId: r.id, tenantId: s.tenantId }, orderBy: { actionIndex: 'asc' } }))
          .then((steps) => steps.map((st) => ({ ...st, input: JSON.stringify(st.input), output: st.output && JSON.stringify(st.output) }))),
    });
    const rootValue = {
      runs: async (a: { status?: string; ruleId?: string; first: number; after?: string }) => {
        const first = Math.min(Math.max(a.first, 1), 100);
        const rows = await this.db.withTenantRead(s.tenantId, (tx) =>
          tx.automationRun.findMany({
            where: { tenantId: s.tenantId, ...(a.status && { status: a.status as never }), ...(a.ruleId && { ruleId: a.ruleId }), ...(a.after && { id: { lt: a.after } }) },
            orderBy: { id: 'desc' }, take: first + 1,
          }),
        );
        const nodes = rows.slice(0, first);
        return { nodes: nodes.map(shape), nextCursor: rows.length > first ? nodes.at(-1)!.id : null };
      },
      run: async (a: { id: string }) => {
        if (!z.uuid().safeParse(a.id).success) return null;
        const r = await this.db.withTenantRead(s.tenantId, (tx) => tx.automationRun.findFirst({ where: { id: a.id, tenantId: s.tenantId } }));
        return r && shape(r);
      },
    };
    return graphql({ schema, source: query, rootValue, variableValues: variables, operationName });
  }
}
