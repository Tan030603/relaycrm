-- AlterTable
ALTER TABLE "domain_events" ADD COLUMN     "traceparent" TEXT;


-- The relay hands the trace context to the queue job.
DROP FUNCTION claim_domain_events(int, int);
CREATE FUNCTION claim_domain_events(batch int, lease_seconds int)
RETURNS TABLE (id uuid, tenant_id uuid, type text, depth int, traceparent text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE domain_events e
     SET locked_until = now() + make_interval(secs => lease_seconds), attempts = e.attempts + 1
   WHERE e.id IN (
     SELECT d.id FROM domain_events d
      WHERE d.published_at IS NULL AND (d.locked_until IS NULL OR d.locked_until < now())
      ORDER BY d.id LIMIT batch
      FOR UPDATE SKIP LOCKED)
  RETURNING e.id, e.tenant_id, e.type, e.depth, e.traceparent
$$;
ALTER FUNCTION claim_domain_events(int, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION claim_domain_events(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_domain_events(int, int) TO app_user;
