# 6. At-least-once delivery plus idempotency

Status: accepted

## Context
Exactly-once delivery across Postgres, Redis, SMTP and webhooks is not achievable. Workers crash, jobs get redelivered, users click retry.

## Decision
Accept at-least-once delivery and make every effect idempotent:
- Runs: `UNIQUE (tenant_id, idempotency_key)` with key `rule_id:event_id`, inserted with `ON CONFLICT DO NOTHING`.
- Queue: deterministic job ids (`event id`, `run-<id>-<attempt>`).
- Steps: key `run_id:action_index`; `create_task` stores it in a unique column, `send_email` uses it as the Message-ID, webhooks send it as `Idempotency-Key`. Retries skip steps that already succeeded.
- API: `Idempotency-Key` header on creating POSTs replays the first response.

## Consequences
- Duplicate delivery is a no-op (tested by re-enqueuing a processed event).
- Every new action handler must define how it dedupes.
