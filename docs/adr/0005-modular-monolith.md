# 5. Modular monolith, two entrypoints

Status: accepted

## Context
One developer, a demo in weeks, but API and workers must scale independently.

## Decision
One codebase (`apps/api`) and one image with two entrypoints: `dist/src/main.js` (HTTP API) and `dist/src/worker.js` (outbox relay, consumers, scheduler). The spec's `packages/core|db|queue` split is folded into folders (`src/automation/engine.ts` is framework-free and unit-tested on its own).

## Consequences
- One build, one migration path, shared types; scale API and workers with separate replica counts (Compose `--scale`, Kubernetes HPA vs KEDA).
- Extract packages or services only when a real boundary or bottleneck appears.
