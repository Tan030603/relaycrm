-- Stale means "no progress for longer than any healthy path takes": never started for
-- older_than_seconds, or started (running / retrying with backoff up to 5 min) for twice that.
CREATE OR REPLACE FUNCTION stale_runs(older_than_seconds int, batch int)
RETURNS TABLE (id uuid, tenant_id uuid, attempt int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.tenant_id, r.attempt FROM automation_runs r
   WHERE (r.status = 'queued' AND r.started_at IS NULL AND r.created_at < now() - make_interval(secs => older_than_seconds))
      OR (r.status IN ('queued', 'running') AND r.started_at < now() - make_interval(secs => older_than_seconds * 2))
   ORDER BY r.created_at LIMIT batch
$$;
