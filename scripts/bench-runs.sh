#!/usr/bin/env bash
# Processing throughput (SPECS 8.1: 1,000 runs/s). Needs the growth-style _inject_pool
# table (see docs/benchmarks.md section 9) and the Compose stack with N workers:
#   docker compose up -d --scale worker=8 worker && scripts/bench-runs.sh 30000
set -euo pipefail
N=${1:-30000}
q() { docker compose exec -T postgres psql -U relaycrm -d relaycrm -Atq -c "$1"; }

start=$(q "SELECT now()")
q "INSERT INTO domain_events (tenant_id, type, aggregate_type, aggregate_id, payload)
   SELECT tenant_id, 'deal.stage_changed', 'deal', deal_id, payload FROM _inject_pool WHERE k < $N"
echo "injected $N events at $start"

while :; do
  left=$(q "SELECT (SELECT count(*) FROM domain_events WHERE occurred_at >= '$start' AND published_at IS NULL)
             + (SELECT count(*) FROM automation_runs WHERE created_at >= '$start' AND status IN ('queued','running'))")
  done_=$(q "SELECT count(*) FROM automation_runs WHERE created_at >= '$start' AND status IN ('succeeded','failed')")
  echo "$(date +%T) finished=$done_ pending=$left"
  [ "$left" = 0 ] && [ "$done_" != 0 ] && break
  sleep 5
done

q "SELECT status, count(*),
          round(count(*) / extract(epoch FROM max(finished_at) - min(created_at))::numeric, 1) AS per_s,
          round(extract(epoch FROM max(finished_at) - min(created_at))::numeric, 1) AS drain_s
     FROM automation_runs WHERE created_at >= '$start' GROUP BY status"
