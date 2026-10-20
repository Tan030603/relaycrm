# 3. BullMQ on Redis for queues

Status: accepted

## Context
We need retries with backoff, delayed jobs, stalled-job recovery, scheduled jobs and visibility into queue depth, from Node, at tens to hundreds of events per second.

## Decision
BullMQ on Redis: queues `events`, `actions`, `dlq`, `maintenance`. Custom backoff 5 s / 30 s / 5 min, max 3 attempts; non-retryable errors fail immediately (`UnrecoverableError`) and land in `dlq`. Redis runs with `noeviction` and AOF.

## Consequences
- Simple to run locally and in managed Redis; KEDA can scale workers on list length.
- Not a log: no replay of history (the outbox and run tables are the history).
- Rejected for now: Kafka (operational weight), RabbitMQ (another system to learn and run), SQS (cloud lock-in for a local demo).
