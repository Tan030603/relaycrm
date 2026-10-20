-- Monthly range partitions for append-heavy history (SPECS 8.3 stage 2):
--   automation_runs        by created_at (set to the event's occurred_at, so a redelivered
--                          event lands in the same partition and the unique key still dedupes)
--   automation_run_steps   by run_created_at (same month as its run)
--   activities             by occurred_at
-- Retention becomes DROP PARTITION instead of mass DELETE. Hand-written; Prisma models
-- use composite ids that match these primary keys.

ALTER TABLE automation_run_steps DROP CONSTRAINT automation_run_steps_run_id_fkey;
ALTER TABLE automation_runs RENAME TO automation_runs_old;
ALTER TABLE automation_run_steps RENAME TO automation_run_steps_old;
ALTER TABLE activities RENAME TO activities_old;
ALTER INDEX automation_runs_pkey RENAME TO automation_runs_old_pkey;
ALTER INDEX automation_run_steps_pkey RENAME TO automation_run_steps_old_pkey;
ALTER INDEX activities_pkey RENAME TO activities_old_pkey;
DROP INDEX automation_runs_tenant_id_idempotency_key_key, automation_runs_tenant_id_id_idx, automation_runs_tenant_id_status_id_idx,
  automation_runs_tenant_id_rule_id_id_idx, automation_runs_tenant_id_aggregate_id_idx,
  automation_run_steps_run_id_action_index_key, automation_run_steps_tenant_id_run_id_idx,
  activities_tenant_id_deal_id_occurred_at_idx, activities_tenant_id_contact_id_occurred_at_idx, activities_tenant_id_occurred_at_idx;

CREATE TABLE automation_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    tenant_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    rule_version integer NOT NULL,
    rule_snapshot jsonb NOT NULL,
    payload jsonb NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status run_status DEFAULT 'queued' NOT NULL,
    skip_reason text,
    attempt integer DEFAULT 0 NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp(3) with time zone,
    finished_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT automation_runs_pkey PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE UNIQUE INDEX automation_runs_tenant_id_idempotency_key_created_at_key ON automation_runs (tenant_id, idempotency_key, created_at);
CREATE INDEX automation_runs_tenant_id_id_idx ON automation_runs (tenant_id, id);
CREATE INDEX automation_runs_tenant_id_status_id_idx ON automation_runs (tenant_id, status, id);
CREATE INDEX automation_runs_tenant_id_rule_id_id_idx ON automation_runs (tenant_id, rule_id, id);
CREATE INDEX automation_runs_tenant_id_aggregate_id_idx ON automation_runs (tenant_id, aggregate_id);

-- No FK to automation_runs: retention drops matching monthly partitions of both tables.
CREATE TABLE automation_run_steps (
    id uuid DEFAULT uuidv7() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    run_created_at timestamp(3) with time zone NOT NULL,
    action_index integer NOT NULL,
    action_type text NOT NULL,
    status step_status NOT NULL,
    input jsonb NOT NULL,
    output jsonb,
    error text,
    tries integer DEFAULT 1 NOT NULL,
    history jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp(3) with time zone,
    CONSTRAINT automation_run_steps_pkey PRIMARY KEY (id, run_created_at)
) PARTITION BY RANGE (run_created_at);
CREATE UNIQUE INDEX automation_run_steps_run_id_action_index_run_created_at_key ON automation_run_steps (run_id, action_index, run_created_at);
CREATE INDEX automation_run_steps_tenant_id_run_id_idx ON automation_run_steps (tenant_id, run_id);

CREATE TABLE activities (
    id uuid DEFAULT uuidv7() NOT NULL,
    tenant_id uuid NOT NULL,
    type text NOT NULL,
    contact_id uuid,
    deal_id uuid,
    note text NOT NULL,
    actor_id uuid,
    occurred_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT activities_pkey PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX activities_tenant_id_deal_id_occurred_at_idx ON activities (tenant_id, deal_id, occurred_at);
CREATE INDEX activities_tenant_id_contact_id_occurred_at_idx ON activities (tenant_id, contact_id, occurred_at);
CREATE INDEX activities_tenant_id_occurred_at_idx ON activities (tenant_id, occurred_at);

-- RLS on the parents (all app queries go through them). New partitions also get
-- RLS enabled + forced with no policy, so querying a partition directly sees nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_runs','automation_run_steps','activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = (SELECT app_tenant_id())) WITH CHECK (tenant_id = (SELECT app_tenant_id()))', t);
  END LOOP;
END $$;

-- Creates this month's and the next 2 months' partitions, plus a DEFAULT catch-all.
-- Runs as the table owner (SECURITY DEFINER) so the worker can call it daily.
CREATE FUNCTION ensure_history_partitions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t text; m date; part text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_runs','automation_run_steps','activities'] LOOP
    FOR i IN 0..2 LOOP
      m := (date_trunc('month', now()) + make_interval(months => i))::date;
      part := format('%s_%s', t, to_char(m, 'YYYYMM'));
      IF to_regclass(part) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, t, m, (m + interval '1 month')::date);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
      END IF;
    END LOOP;
    part := t || '_default';
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', part, t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
    END IF;
  END LOOP;
END $$;

-- Run history retention: drop whole monthly partitions older than keep_days (cheap, no
-- mass DELETE, no vacuum debt). Activities are CRM history and are never dropped.
CREATE FUNCTION drop_old_run_partitions(keep_days int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('automation_runs', 'automation_run_steps')
       AND c.relname ~ '_\d{6}$'
       AND to_date(right(c.relname, 6), 'YYYYMM') + interval '1 month' < now() - make_interval(days => keep_days)
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION ensure_history_partitions(), drop_old_run_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_history_partitions(), drop_old_run_partitions(int) TO app_user;

-- Partitions for every month that already has data, then the standard window.
DO $$
DECLARE m date; t text;
BEGIN
  FOR t, m IN
    SELECT 'automation_runs', date_trunc('month', created_at)::date FROM automation_runs_old
    UNION SELECT 'automation_run_steps', date_trunc('month', r.created_at)::date FROM automation_run_steps_old s JOIN automation_runs_old r ON r.id = s.run_id
    UNION SELECT 'activities', date_trunc('month', occurred_at)::date FROM activities_old
  LOOP
    IF to_regclass(format('%s_%s', t, to_char(m, 'YYYYMM'))) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', format('%s_%s', t, to_char(m, 'YYYYMM')), t, m, (m + interval '1 month')::date);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', format('%s_%s', t, to_char(m, 'YYYYMM')));
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', format('%s_%s', t, to_char(m, 'YYYYMM')));
    END IF;
  END LOOP;
END $$;
SELECT ensure_history_partitions();

INSERT INTO automation_runs (id, tenant_id, rule_id, rule_version, rule_snapshot, payload, event_id, event_type, aggregate_id, idempotency_key, status, skip_reason, attempt, depth, error, started_at, finished_at, created_at)
  SELECT id, tenant_id, rule_id, rule_version, rule_snapshot, payload, event_id, event_type, aggregate_id, idempotency_key, status, skip_reason, attempt, depth, error, started_at, finished_at, created_at FROM automation_runs_old;
INSERT INTO automation_run_steps (id, tenant_id, run_id, run_created_at, action_index, action_type, status, input, output, error, tries, history, started_at, finished_at)
  SELECT s.id, s.tenant_id, s.run_id, r.created_at, s.action_index, s.action_type, s.status, s.input, s.output, s.error, s.tries, s.history, s.started_at, s.finished_at
    FROM automation_run_steps_old s JOIN automation_runs_old r ON r.id = s.run_id;
INSERT INTO activities (id, tenant_id, type, contact_id, deal_id, note, actor_id, occurred_at)
  SELECT id, tenant_id, type, contact_id, deal_id, note, actor_id, occurred_at FROM activities_old;

DROP TABLE automation_run_steps_old, automation_runs_old, activities_old;

-- purge_old_data no longer deletes runs row by row (partitions are dropped instead).
CREATE OR REPLACE FUNCTION purge_old_data() RETURNS TABLE (events bigint, runs bigint, keys bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM domain_events WHERE published_at < now() - interval '7 days';
  GET DIAGNOSTICS events = ROW_COUNT;
  runs := 0;
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS keys = ROW_COUNT;
  RETURN NEXT;
END $$;
