# Back-end needs raised by the interface (2026-08-16)

## Implemented

- `plan.list` supports signed cursor pagination, a bounded limit, and Procedure / mode filters.
- `history.list` returns Check Snapshots newest first with Plan, Procedure, mode, Check, target,
  Operation, Attempt, verdict, reason, Fact count and checklist delta. It supports signed cursor
  pagination and Plan / Procedure / mode / verdict / time filters.
- `GET /events/plans` streams `plan.engaged`, `plan.revision`, `plan.removed` and `session.changed`
  events over SSE. SQL remains authoritative after a reconnect.
- `check.attempt.admit { reobserve: true }` explicitly re-observes a satisfied Check for dry-run
  Plans only. A normal pending Attempt cannot become an implicit re-observation.
- `operation.save` compiles, writes atomically and reloads the configured Operation catalog;
  `operation.remove` removes one exact Operation version and reloads it.
- `operation.list` and `procedure.list` accept `{ summary: true }`.
- Failure reasons have the same value whether they come from a Check sentence or a predicate table.
- `plan.close` closes the open Session while retaining the Plan and its history.

## Product decisions still open

- Manual validation on a live Plan needs a compiled human-confirmation Check contract and an
  operator identity Fact. No generic manual override is implemented.
- Credentials already have separate persisted values and public reference-only reads. The product
  must still decide which credential references the interface exposes and whether values may ever
  be entered from the interface.
