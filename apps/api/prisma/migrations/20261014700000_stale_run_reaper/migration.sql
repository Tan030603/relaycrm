-- Safety net for at-least-once: runs stuck in queued/running whose queue job is gone
-- (lost during a crash or redeploy) are found here and re-enqueued by the worker.
GRANT SELECT ON automation_runs TO app_maintenance;
CREATE POLICY maintenance_read ON automation_runs FOR SELECT TO app_maintenance USING (true);

CREATE FUNCTION stale_runs(older_than_seconds int, batch int)
RETURNS TABLE (id uuid, tenant_id uuid, attempt int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.tenant_id, r.attempt FROM automation_runs r
   WHERE r.status IN ('queued', 'running')
     AND coalesce(r.started_at, r.created_at) < now() - make_interval(secs => older_than_seconds)
   ORDER BY r.created_at LIMIT batch
$$;
ALTER FUNCTION stale_runs(int, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION stale_runs(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_runs(int, int) TO app_user;
