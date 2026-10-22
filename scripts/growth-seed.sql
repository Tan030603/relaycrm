-- Growth-target dataset (SPECS 8.1): 5,000 tenants x 200 users, 50M contacts, 500k deals.
-- Run as the owner role on an empty, migrated database (bulk load bypasses RLS on purpose):
--   psql "$MIGRATION_DATABASE_URL" -v pw_hash="'<argon2 hash>'" -f scripts/growth-seed.sql
-- Logins: growth-<n>@relaycrm.test (owner of tenant n), same password as the hash given.
\timing on
SET synchronous_commit = off;

CREATE TEMP TABLE t AS SELECT n, uuidv7() AS id FROM generate_series(0, 4999) n;
INSERT INTO tenants (id, name, slug) SELECT id, 'Growth ' || n, 'growth-' || n FROM t;

CREATE TEMP TABLE u AS SELECT t.n, t.id AS tenant_id, k, uuidv7() AS id FROM t, generate_series(0, 199) k;
INSERT INTO users (id, email, password_hash, name)
  SELECT id, CASE WHEN k = 0 THEN 'growth-' || n || '@relaycrm.test' ELSE 'g' || n || '-' || k || '@relaycrm.test' END, :pw_hash, 'User ' || n || '-' || k FROM u;
INSERT INTO memberships (tenant_id, user_id, role) SELECT tenant_id, id, CASE WHEN k = 0 THEN 'owner'::role ELSE 'rep'::role END FROM u;

-- Contacts: load without secondary indexes, then build them (much faster than per-row index maintenance).
DROP INDEX contacts_tenant_id_id_idx, contacts_tenant_id_email_idx, contacts_tenant_id_owner_id_idx, contacts_tenant_id_form_id_created_at_idx;
INSERT INTO contacts (tenant_id, name, email, company, owner_id, updated_at)
  SELECT u.tenant_id, 'Contact ' || u.n || '-' || u.k || '-' || c, 'c' || c || '.' || u.k || '@t' || u.n || '.example', 'Company ' || (c % 500), u.id, now()
    FROM u, generate_series(0, 49) c;          -- 200 users x 50 = 10,000 contacts per tenant
CREATE INDEX contacts_tenant_id_id_idx ON contacts (tenant_id, id);
CREATE INDEX contacts_tenant_id_email_idx ON contacts (tenant_id, email);
CREATE INDEX contacts_tenant_id_owner_id_idx ON contacts (tenant_id, owner_id);
CREATE INDEX contacts_tenant_id_form_id_created_at_idx ON contacts (tenant_id, form_id, created_at);

INSERT INTO deals (tenant_id, title, value, stage, owner_id, updated_at, stage_changed_at)
  SELECT u.tenant_id, 'Deal ' || u.n || '-' || u.k, (u.k * 997) % 90000 + 1000, (ARRAY['new','qualified','proposal','negotiation','won']::deal_stage[])[1 + u.k % 5], u.id, now(), now() - make_interval(days => u.k % 20)
    FROM u WHERE u.k < 100;                     -- 100 deals per tenant

INSERT INTO automation_rules (tenant_id, name, trigger_type, conditions, actions, template_key, updated_at)
  SELECT id, 'High-value proposal', 'deal.stage_changed',
         '{"all":[{"field":"deal.value","op":"gt","value":50000},{"field":"deal.stage","op":"eq","value":"proposal"}]}',
         '[{"type":"create_task","params":{"title":"Review {{deal.title}}","assignee":"deal_owner","due_in_hours":24}},{"type":"send_email","params":{"to":"{{deal.owner.email}}","template":"high_value_deal"}}]',
         'high_value_proposal', now()
    FROM t;

ANALYZE;
SELECT (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM contacts) AS contacts, (SELECT count(*) FROM deals) AS deals,
       pg_size_pretty(pg_database_size(current_database())) AS size;
