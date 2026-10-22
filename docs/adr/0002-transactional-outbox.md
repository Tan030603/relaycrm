# 2. Transactional outbox for domain events

Status: accepted

## Context
A deal moving stage must trigger rules. Publishing to Redis directly from the API can lose events (commit succeeded, publish failed) or create phantom ones (publish succeeded, commit rolled back).

## Decision
The API writes the business row and a `domain_events` row in the same transaction. A relay leases unpublished rows (`FOR UPDATE SKIP LOCKED`, 30 s lease), enqueues them with `jobId = event id`, then marks them published. A partial index on unpublished rows keeps polling cheap.

## Consequences
- At-least-once delivery; duplicates are absorbed by idempotency (ADR 6).
- Redis can be down without data loss: events wait in Postgres.
- Polling every 200 ms adds a little latency; `LISTEN/NOTIFY` can wake the relay if needed.
- Manual retries also go through the outbox, so the API never needs Redis to accept writes.
