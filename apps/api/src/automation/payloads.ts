import type { Tx } from '../db';

// Event payloads carry everything conditions and templates may read, frozen at the
// time of the event, so a rule run later still sees what actually happened.

const person = (u: { id: string; name: string; email: string } | null | undefined) => (u ? { id: u.id, name: u.name, email: u.email } : null);
const userSelect = { id: true, name: true, email: true } as const;

async function tenantName(tx: Tx) {
  return (await tx.tenant.findFirst({ select: { name: true } }))?.name ?? '';
}

export async function contactPayload(tx: Tx, contactId: string) {
  const c = await tx.contact.findFirstOrThrow({ where: { id: contactId } });
  const owner = c.ownerId ? await tx.user.findUnique({ where: { id: c.ownerId }, select: userSelect }) : null;
  return {
    tenant: { name: await tenantName(tx) },
    contact: { id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company, source: c.source, tags: c.tags, owner: person(owner) },
  };
}

export async function dealPayload(tx: Tx, dealId: string, extra: { from_stage?: string; idle_days?: number } = {}) {
  const d = await tx.deal.findFirstOrThrow({ where: { id: dealId }, include: { contact: true } });
  const owner = d.ownerId ? await tx.user.findUnique({ where: { id: d.ownerId }, select: userSelect }) : null;
  return {
    tenant: { name: await tenantName(tx) },
    deal: { id: d.id, title: d.title, value: Number(d.value), currency: d.currency, stage: d.stage, owner: person(owner), ...extra },
    contact: d.contact ? { id: d.contact.id, name: d.contact.name, email: d.contact.email, company: d.contact.company, phone: d.contact.phone } : null,
  };
}
