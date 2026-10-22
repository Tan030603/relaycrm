-- The reaper (stale_runs, every minute) only looks at unfinished runs. Without this index
-- it scanned the whole partition: 25 s per call at 1.2M runs, competing with every run write.
-- Partial, so it holds only the handful of queued/running rows and costs almost nothing to maintain.
CREATE INDEX automation_runs_active_idx ON automation_runs (created_at) WHERE status IN ('queued', 'running');
