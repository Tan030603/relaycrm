// Tenant isolation suite (spec 4.4): plain SQL as app_user, no application code in
// between, so these prove the database itself enforces isolation.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';

const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const app = new Client({ connectionString: process.env.DATABASE_URL });

async function inTenant<T>(db: Client, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn();
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// Seeds through the policies too (no superuser shortcut), so it works on managed Postgres.
async function seedTenant(name: string) {
  const { rows } = await owner.query<{ id: string }>('SELECT uuidv7()::text AS id');
  const tenantId = rows[0].id;
  const contactId = await inTenant(owner, tenantId, async () => {
    await owner.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, name, `${name}-${tenantId}`]);
    const c = await owner.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, name, updated_at) VALUES ($1, $2, now()) RETURNING id`,
      [tenantId, `${name} contact`],
    );
    return c.rows[0].id;
  });
  return { tenantId, contactId };
}

let a: { tenantId: string; contactId: string };
let b: { tenantId: string; contactId: string };

before(async () => {
  await owner.connect();
  await app.connect();
  a = await seedTenant('tenant-a');
  b = await seedTenant('tenant-b');
});

after(async () => {
  await owner.end();
  await app.end();
});

test('app_user is not a superuser and cannot bypass RLS', async () => {
  const { rows } = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
});

test('no tenant context: sees zero rows (fails closed)', async () => {
  const contacts = await app.query('SELECT count(*)::int AS n FROM contacts');
  const tenants = await app.query('SELECT count(*)::int AS n FROM tenants');
  assert.equal(contacts.rows[0].n, 0);
  assert.equal(tenants.rows[0].n, 0);
});

test('tenant A sees only its own rows', async () => {
  const rows = await inTenant(app, a.tenantId, async () => (await app.query('SELECT id, tenant_id FROM contacts')).rows);
  assert.ok(rows.some((r) => r.id === a.contactId));
  assert.ok(rows.every((r) => r.tenant_id === a.tenantId));
  assert.ok(!rows.some((r) => r.id === b.contactId));
});

test('tenant A cannot update or delete tenant B rows', async () => {
  const updated = await inTenant(app, a.tenantId, () => app.query(`UPDATE contacts SET name = 'hacked' WHERE id = $1`, [b.contactId]));
  const deleted = await inTenant(app, a.tenantId, () => app.query('DELETE FROM contacts WHERE id = $1', [b.contactId]));
  assert.equal(updated.rowCount, 0);
  assert.equal(deleted.rowCount, 0);
  const still = await inTenant(app, b.tenantId, () => app.query('SELECT name FROM contacts WHERE id = $1', [b.contactId]));
  assert.equal(still.rows[0].name, 'tenant-b contact');
});

test('tenant A cannot insert a row with tenant B id (WITH CHECK)', async () => {
  await assert.rejects(
    inTenant(app, a.tenantId, () =>
      app.query(`INSERT INTO contacts (tenant_id, name, updated_at) VALUES ($1, 'sneaky', now())`, [b.tenantId]),
    ),
    { code: '42501' },
  );
});

test('tenant A cannot move its row to tenant B', async () => {
  await assert.rejects(
    inTenant(app, a.tenantId, () => app.query('UPDATE contacts SET tenant_id = $1 WHERE id = $2', [b.tenantId, a.contactId])),
    { code: '42501' },
  );
});

test('tenant context ends with the transaction (safe with pooled connections)', async () => {
  await inTenant(app, a.tenantId, () => app.query('SELECT 1'));
  const { rows } = await app.query('SELECT count(*)::int AS n FROM contacts');
  assert.equal(rows[0].n, 0);
});

test('every table with a tenant_id column has RLS enabled, forced and a tenant policy', async () => {
  const { rows } = await owner.query<{ table: string; partition: boolean; enabled: boolean; forced: boolean; policy: boolean }>(`
    SELECT c.relname AS table, c.relispartition AS partition, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policy
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace AND a.attname = 'tenant_id' AND NOT a.attisdropped
       AND c.relname NOT IN ('refresh_tokens', 'tenant_shards')`); // global directory tables, by design
  assert.ok(rows.filter((r) => !r.partition).length >= 12, `found ${rows.length} tenant tables`);
  for (const r of rows) {
    // Parents carry the policy; monthly partitions are RLS-enabled with no policy, so
    // querying one directly (bypassing the parent) returns nothing.
    assert.deepEqual([r.table, r.enabled, r.forced, r.partition || r.policy], [r.table, true, true, true]);
  }
});

test('querying a history partition directly bypasses nothing', async () => {
  const { rows } = await owner.query<{ name: string }>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'automation_runs' LIMIT 1`);
  assert.ok(rows.length, 'automation_runs is partitioned');
  const r = await inTenant(app, a.tenantId, () => app.query(`SELECT count(*)::int AS n FROM ${rows[0].name}`));
  assert.equal(r.rows[0].n, 0);
});

test('app_user cannot read the outbox across tenants directly', async () => {
  const { rows } = await app.query('SELECT count(*)::int AS n FROM domain_events');
  assert.equal(rows[0].n, 0, 'no tenant context → zero rows, even for the outbox');
});
