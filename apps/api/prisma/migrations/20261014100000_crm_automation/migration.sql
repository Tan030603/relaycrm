-- CreateEnum
CREATE TYPE "deal_stage" AS ENUM ('new', 'qualified', 'proposal', 'negotiation', 'won');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('open', 'done');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "step_status" AS ENUM ('running', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "form_id" UUID;

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID,
    "title" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stage" "deal_stage" NOT NULL DEFAULT 'new',
    "owner_id" UUID,
    "expected_close_date" DATE,
    "stage_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_event_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "assignee_id" UUID,
    "status" "task_status" NOT NULL DEFAULT 'open',
    "deal_id" UUID,
    "contact_id" UUID,
    "created_by_rule_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "contact_id" UUID,
    "deal_id" UUID,
    "note" TEXT NOT NULL,
    "actor_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "trigger_type" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "template_key" TEXT,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "rule_snapshot" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run_steps" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "action_index" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "status" "step_status" NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "tries" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_forms" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "headline" TEXT NOT NULL DEFAULT 'Talk to our team',
    "fields" JSONB NOT NULL,
    "assign_to_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_id_idx" ON "invitations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "deals_tenant_id_stage_id_idx" ON "deals"("tenant_id", "stage", "id");

-- CreateIndex
CREATE INDEX "deals_tenant_id_owner_id_idx" ON "deals"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "deals_tenant_id_stage_changed_at_idx" ON "deals"("tenant_id", "stage_changed_at");

-- CreateIndex
CREATE INDEX "deals_tenant_id_contact_id_idx" ON "deals"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_assignee_id_status_due_at_idx" ON "tasks"("tenant_id", "assignee_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_status_id_idx" ON "tasks"("tenant_id", "status", "id");

-- CreateIndex
CREATE INDEX "tasks_tenant_id_deal_id_idx" ON "tasks"("tenant_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tenant_id_idempotency_key_key" ON "tasks"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "activities_tenant_id_deal_id_occurred_at_idx" ON "activities"("tenant_id", "deal_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activities_tenant_id_contact_id_occurred_at_idx" ON "activities"("tenant_id", "contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activities_tenant_id_occurred_at_idx" ON "activities"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "automation_rules_tenant_id_trigger_type_enabled_idx" ON "automation_rules"("tenant_id", "trigger_type", "enabled");

-- CreateIndex
CREATE INDEX "automation_rules_tenant_id_id_idx" ON "automation_rules"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "domain_events_tenant_id_aggregate_id_idx" ON "domain_events"("tenant_id", "aggregate_id");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_id_idx" ON "automation_runs"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_status_id_idx" ON "automation_runs"("tenant_id", "status", "id");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_rule_id_id_idx" ON "automation_runs"("tenant_id", "rule_id", "id");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_aggregate_id_idx" ON "automation_runs"("tenant_id", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_tenant_id_idempotency_key_key" ON "automation_runs"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "automation_run_steps_tenant_id_run_id_idx" ON "automation_run_steps"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_steps_run_id_action_index_key" ON "automation_run_steps"("run_id", "action_index");

-- CreateIndex
CREATE INDEX "lead_forms_tenant_id_id_idx" ON "lead_forms"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_id_idx" ON "audit_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_form_id_created_at_idx" ON "contacts"("tenant_id", "form_id", "created_at");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ===================================================================
-- Hand-written: RLS, outbox index, maintenance functions.
-- ===================================================================

-- Relay polls only unpublished rows; this stays tiny however big the table gets.
CREATE INDEX domain_events_unpublished_idx ON domain_events (id) WHERE published_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations','deals','tasks','activities','automation_rules',
    'domain_events','automation_runs','automation_run_steps','lead_forms','idempotency_keys','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = (SELECT app_tenant_id())) WITH CHECK (tenant_id = (SELECT app_tenant_id()))', t);
  END LOOP;
END $$;

-- refresh_tokens is global like users (looked up by hash before a tenant is known).

-- Cross-tenant jobs (outbox relay, retention) run through SECURITY DEFINER functions
-- owned by app_maintenance: a NOLOGIN role whose policies allow only what those
-- functions do. app_user can call the functions but never reads other tenants directly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_maintenance;
GRANT SELECT, UPDATE, DELETE ON domain_events TO app_maintenance;
GRANT SELECT, DELETE ON automation_runs, idempotency_keys TO app_maintenance;
CREATE POLICY maintenance ON domain_events TO app_maintenance USING (true) WITH CHECK (true);
CREATE POLICY maintenance ON automation_runs TO app_maintenance USING (true);
CREATE POLICY maintenance ON idempotency_keys TO app_maintenance USING (true);

-- Leases a batch of unpublished events. A relay that dies mid-batch loses its lease
-- and another relay picks the rows up: at-least-once. SKIP LOCKED lets N relays run.
CREATE FUNCTION claim_domain_events(batch int, lease_seconds int)
RETURNS TABLE (id uuid, tenant_id uuid, type text, depth int)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE domain_events e
     SET locked_until = now() + make_interval(secs => lease_seconds), attempts = e.attempts + 1
   WHERE e.id IN (
     SELECT d.id FROM domain_events d
      WHERE d.published_at IS NULL AND (d.locked_until IS NULL OR d.locked_until < now())
      ORDER BY d.id LIMIT batch
      FOR UPDATE SKIP LOCKED)
  RETURNING e.id, e.tenant_id, e.type, e.depth
$$;

CREATE FUNCTION mark_domain_events_published(ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE domain_events SET published_at = now(), locked_until = NULL WHERE id = ANY(ids)
$$;

-- ponytail: plain DELETEs. Monthly partitions of automation_runs/steps make this a
-- cheap DROP PARTITION once run history reaches tens of millions of rows.
CREATE FUNCTION purge_old_data() RETURNS TABLE (events bigint, runs bigint, keys bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM domain_events WHERE published_at < now() - interval '7 days';
  GET DIAGNOSTICS events = ROW_COUNT;
  DELETE FROM automation_runs WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS runs = ROW_COUNT;
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS keys = ROW_COUNT;
  RETURN NEXT;
END $$;

ALTER FUNCTION claim_domain_events(int, int) OWNER TO app_maintenance;
ALTER FUNCTION mark_domain_events_published(uuid[]) OWNER TO app_maintenance;
ALTER FUNCTION purge_old_data() OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION claim_domain_events(int, int), mark_domain_events_published(uuid[]), purge_old_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_domain_events(int, int), mark_domain_events_published(uuid[]), purge_old_data() TO app_user;

-- Time-based trigger: the scheduler claims deals that sat in one stage too long.
-- idle_event_at makes it fire once per stage visit.
CREATE INDEX deals_idle_scan_idx ON deals (stage_changed_at) WHERE stage <> 'won';
GRANT SELECT, UPDATE ON deals TO app_maintenance;
CREATE POLICY maintenance ON deals TO app_maintenance USING (true) WITH CHECK (true);
CREATE FUNCTION claim_idle_deals(idle_days int, batch int) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE deals d SET idle_event_at = now()
   WHERE d.id IN (
     SELECT x.id FROM deals x
      WHERE x.stage <> 'won' AND x.stage_changed_at < now() - make_interval(days => idle_days)
        AND (x.idle_event_at IS NULL OR x.idle_event_at < x.stage_changed_at)
      ORDER BY x.stage_changed_at LIMIT batch
      FOR UPDATE SKIP LOCKED)
  RETURNING d.id, d.tenant_id
$$;
ALTER FUNCTION claim_idle_deals(int, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION claim_idle_deals(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_idle_deals(int, int) TO app_user;
