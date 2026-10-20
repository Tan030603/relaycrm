// Demo data: `pnpm --filter api seed` (or `node dist/src/seed.js` in the image).
//   Northwind Trading: owner sam@northwind.example plus two reps, a lived-in pipeline.
//   Globex: a second tenant, to show isolation.
//   --tenants N --contacts M: bulk tenants for load tests (loadtest-<i>@relaycrm.test).
// Every login uses SEED_PASSWORD (default "relaycrm-demo"); demo data only.
import { hashPassword } from './auth/password';
import { RULE_TEMPLATES } from './automation/engine';
import { Db, Tx } from './db';
import { DealStage, Prisma } from './generated/prisma/client';

const PASSWORD = process.env.SEED_PASSWORD ?? 'relaycrm-demo';
const DAY = 86_400_000;
const arg = (name: string) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1] || 0) || undefined;

const COMPANIES = ['Summit Foods', 'Orion Paints', 'Bluebird Logistics', 'Kestrel Labs', 'Harbor Dental', 'Maple Retail', 'Nova Fitness', 'Cobalt Freight', 'Juniper Hotels', 'Atlas Print', 'Lumen Solar', 'Pioneer Farms'];
const PEOPLE = ['Priya Nair', 'Daniel Okafor', 'Hana Suzuki', 'Marco Rossi', 'Aisha Rahman', 'Tom Becker', 'Lucía Gómez', 'Wei Zhang', 'Grace Mensah', 'Omar Haddad', 'Sofia Novak', 'Ben Carter'];
const DEALS: [string, number, DealStage, number][] = [
  ['ERP integration', 64000, 'proposal', 0], ['Warehouse scanners', 18500, 'new', 1], ['Annual paint supply', 42000, 'qualified', 3],
  ['Fleet tracking', 27000, 'negotiation', 9], ['Lab data platform', 88000, 'proposal', 12], ['Clinic booking app', 12000, 'won', 4],
  ['POS rollout', 35500, 'qualified', 10], ['Member app', 9800, 'new', 2], ['Route optimiser', 51000, 'negotiation', 1],
  ['Guest Wi-Fi upgrade', 15500, 'won', 20], ['Print portal', 7200, 'new', 0], ['Solar monitoring', 46000, 'qualified', 15],
];

async function tenantWithOwner(db: Db, name: string, owner: { name: string; email: string }, passwordHash: string) {
  const existing = await db.user.findUnique({ where: { email: owner.email } });
  if (existing) return null;
  const [{ id: tenantId }] = await db.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`;
  const user = await db.withTenant(tenantId, async (tx) => {
    await tx.tenant.create({ data: { id: tenantId, name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${tenantId.slice(-6)}` } });
    const user = await tx.user.create({ data: { ...owner, passwordHash } });
    await db.userShard.create({ data: { userId: user.id, email: owner.email, shard: 'default' } });
    await tx.membership.create({ data: { tenantId, userId: user.id, role: 'owner' } });
    await tx.leadForm.create({
      data: {
        tenantId, name: 'Contact us',
        fields: [
          { key: 'name', label: 'Name', required: true }, { key: 'email', label: 'Work email', required: true },
          { key: 'company', label: 'Company', required: false }, { key: 'phone', label: 'Phone', required: false },
          { key: 'message', label: 'How can we help?', required: false },
        ],
      },
    });
    return user;
  });
  return { tenantId, ownerId: user.id };
}

async function installTemplates(tx: Tx, tenantId: string, userId: string, keys: string[]) {
  for (const t of RULE_TEMPLATES.filter((x) => keys.includes(x.key)))
    await tx.automationRule.create({
      data: { ...t.rule, conditions: t.rule.conditions as Prisma.InputJsonValue, actions: t.rule.actions as Prisma.InputJsonValue, description: t.desc, templateKey: t.key, tenantId, createdBy: userId, updatedBy: userId },
    });
}

async function northwind(db: Db, passwordHash: string) {
  const t = await tenantWithOwner(db, 'Northwind Trading', { name: 'Sam Lee', email: 'sam@northwind.example' }, passwordHash);
  if (!t) return console.log('Northwind already seeded');
  const { tenantId, ownerId } = t;
  const reps = await Promise.all(
    [['Mei Kato', 'mei@northwind.example'], ['Jamie Tan', 'jamie@northwind.example']].map(async ([name, email]) => {
      const u = await db.user.create({ data: { name, email, passwordHash } });
      await db.userShard.create({ data: { userId: u.id, email, shard: 'default' } });
      return u;
    }),
  );
  const team = [ownerId, ...reps.map((r) => r.id)];

  await db.withTenant(tenantId, async (tx) => {
    for (const r of reps) await tx.membership.create({ data: { tenantId, userId: r.id, role: 'rep' } });
    const contacts = [];
    for (const [i, name] of PEOPLE.entries()) {
      const company = COMPANIES[i];
      contacts.push(await tx.contact.create({
        data: {
          tenantId, name, company, email: `${name.split(' ')[0].toLowerCase()}@${company.toLowerCase().replace(/\W+/g, '')}.example`,
          phone: `+1 555 01${String(i).padStart(2, '0')}`, source: i % 3 === 0 ? 'Website form · Contact us' : i % 3 === 1 ? 'Referral' : 'Event',
          ownerId: team[i % team.length], tags: i % 4 === 0 ? ['vip'] : [], createdAt: new Date(Date.now() - (30 - i) * DAY),
        },
      }));
    }
    for (const [i, [title, value, stage, daysAgo]] of DEALS.entries()) {
      const c = contacts[i];
      const changed = new Date(Date.now() - daysAgo * DAY);
      const deal = await tx.deal.create({
        data: { tenantId, title, value, stage, contactId: c.id, ownerId: c.ownerId, stageChangedAt: changed, expectedCloseDate: new Date(Date.now() + (10 + i * 3) * DAY), createdAt: new Date(changed.getTime() - 5 * DAY) },
      });
      const notes = [
        ['created', `Deal created in New`, 5],
        ['call', `Intro call with ${c.name}: needs a solution before peak season`, 4],
        ['note', `${c.name} asked about paying in two parts`, 2],
      ] as const;
      for (const [type, note, ago] of notes)
        await tx.activity.create({ data: { tenantId, type, note, dealId: deal.id, contactId: c.id, actorId: c.ownerId, occurredAt: new Date(changed.getTime() - ago * DAY) } });
      if (stage !== 'new')
        await tx.activity.create({ data: { tenantId, type: 'stage_changed', note: `Moved to ${stage[0].toUpperCase()}${stage.slice(1)}`, dealId: deal.id, contactId: c.id, actorId: c.ownerId, occurredAt: changed } });
    }
    const today = new Date();
    for (const [i, title] of ['Call Priya back about pricing', 'Send revised quote to Orion Paints', 'Prepare demo for Kestrel Labs', 'Check contract with Bluebird'].entries())
      await tx.task.create({ data: { tenantId, title, assigneeId: ownerId, dueAt: new Date(today.getTime() + (i - 1) * 3 * 3_600_000), contactId: contacts[i].id } });
    await installTemplates(tx, tenantId, ownerId, ['high_value_proposal', 'new_lead_welcome', 'quiet_deal_nudge']);
  });
  console.log(`Northwind Trading: sam@northwind.example / ${PASSWORD} (owner), mei@ and jamie@ (reps)`);
}

async function bulk(db: Db, passwordHash: string, tenants: number, contactsEach: number) {
  for (let i = 0; i < tenants; i++) {
    const t = await tenantWithOwner(db, `Load Test ${i}`, { name: `Load ${i}`, email: `loadtest-${i}@relaycrm.test` }, passwordHash);
    if (!t) continue;
    await db.withTenant(t.tenantId, async (tx) => {
      for (let off = 0; off < contactsEach; off += 1000)
        await tx.contact.createMany({
          data: Array.from({ length: Math.min(1000, contactsEach - off) }, (_, j) => ({ tenantId: t.tenantId, name: `Contact ${off + j}`, email: `c${off + j}@t${i}.example`, ownerId: t.ownerId })),
        });
      await installTemplates(tx, t.tenantId, t.ownerId, ['high_value_proposal', 'won_handover']);
    });
    if (i % 10 === 9) console.log(`${i + 1}/${tenants} tenants`);
  }
}

async function main() {
  const db = new Db();
  const passwordHash = await hashPassword(PASSWORD);
  const tenants = arg('tenants');
  if (tenants) await bulk(db, passwordHash, tenants, arg('contacts') ?? 1000);
  else {
    await northwind(db, passwordHash);
    if (await tenantWithOwner(db, 'Globex', { name: 'Gina Globex', email: 'gina@globex.example' }, passwordHash)) console.log(`Globex: gina@globex.example / ${PASSWORD}`);
  }
  await db.$disconnect();
}

void main();
