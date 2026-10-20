-- Automation-path latency after a load run (run as the owner role):
--   psql "$MIGRATION_DATABASE_URL" -v since="'10 minutes'" -f scripts/measure-automation.sql
SELECT count(*)                                                        AS events,
       count(*) FILTER (WHERE e.published_at IS NULL)                  AS unpublished
  FROM domain_events e
 WHERE e.occurred_at > now() - (:since)::interval AND e.type <> 'automation.retry';

SELECT r.status, count(*) AS runs,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM r.started_at - e.occurred_at))::numeric, 3) AS p50_event_to_start_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.started_at - e.occurred_at))::numeric, 3) AS p95_event_to_start_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - e.occurred_at))::numeric, 3) AS p95_event_to_done_s,
       round(extract(epoch FROM max(r.finished_at) - min(e.occurred_at))::numeric, 1)                                   AS drain_s
  FROM automation_runs r JOIN domain_events e ON e.id = r.event_id
 WHERE e.occurred_at > now() - (:since)::interval
 GROUP BY r.status;
