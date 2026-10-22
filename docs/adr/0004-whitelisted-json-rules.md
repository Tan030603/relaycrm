# 4. Whitelisted JSON rules, no scripting

Status: accepted

## Context
Tenants define automation. Letting them run code (JS, expressions) invites sandbox escapes, infinite loops and unpredictable cost.

## Decision
Rules are JSON: a trigger, a condition tree (`all`/`any`, depth ≤ 3, operators `eq neq gt gte lt lte contains in`) over fields whitelisted per trigger, and typed actions validated by Zod. Templates are logic-less `{{path}}` substitution over a whitelist of variables. AI rule generation produces the same JSON and goes through the same validation; nothing is saved until the user confirms.

## Consequences
- Predictable and safe; every run records which conditions passed.
- Less expressive than code; new needs are met by adding fields, operators or action handlers (one file each).
