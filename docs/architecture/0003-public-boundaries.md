# ADR 0003 — Public boundaries and persistence

Status: accepted and partially mounted. The subset required by
[TRUST V1 — minimal product scope](../product/v1-minimal-scope.md) is normative for V1. Rich
deployment governance and generic attempt recovery remain post-V1 exploration. RPC, OTLP and the
runtime MCP endpoint are mounted.

## One runtime, four public endpoints

`packages/trust-runtime` is organized by the product functions `procedure`, `plan`, `check` and
`skill`, and by the concrete mechanisms `http` and `sqlite`. Awilix assembles the runtime and is
never fetched from runtime code.

The target public boundaries are:

- `POST /rpc`: typed JSON-RPC machine contract;
- `POST /v1/traces`: authenticated OTLP/HTTP trace and Fact ingestion;
- `/mcp`: Streamable HTTP MCP endpoint for agents;
- `GET /health`: operational health only.

The currently mounted runtime boundaries are:

- `GET /health`;
- `POST /rpc` for public compilation, authenticated Skill registry and preflight, explicit Plan
  engagement, Check reads, delegation admission and finalization;
- `POST /v1/traces` for authenticated Fact ingestion;
- `POST /mcp` for the bounded agent reads `trust_procedure_read`, `trust_plan_read`,
  `trust_session_read` and `trust_check_read`, plus operator-only `trust_plan_engage` and
  `trust_plan_declarations_replace`.

RPC and MCP call the same `PlanRuntime`. MCP is not a proxy to RPC and never returns raw RPC data.
Engagement accepts only procedure, version, Plan, environment and closed root inputs. The
declaration operation accepts only one expected revision and the complete snapshot of roles marked
`declared by agent` by that Feature. It cannot write roots, fixed policy or Skill outputs. Engagement
does not require a live Skill deployment and does not grant permission for an external action.

An authenticated observer sees only the four read tools. An authenticated operator sees those reads
plus both closed Plan writes; a direct observer invocation is refused. The SDK renders the action and
immediate TRUST verdict; MCP renders engagement, procedure, checklist, history and open Checks from
the same semantic view. Neither endpoint recalculates qualification, reasons, delta or
next Check.

The public `procedure.compile` operation accepts one English Gherkin source and its source name.
The runtime compiles it against its configured Operations. The result contains the exact authoring
source, roles, Scenarios, Checks, predicates and the exact compiled Operation used by each Check.
`procedure.publish` persists that result immutably and `procedure.read` returns it. These RPC methods
do not accept a Plan, Session, authority, ticket, project or runtime instance.

The mounted authenticated registry RPC surface is `skill.release.claim`,
`skill.distribution.record-verified`,
`skill.release.authorization.set`, `skill.deployment.authorization.set`,
`skill.deployment.selection.set`, `skill.deployment.announce` and `environment.preflight`.
Compilation and health remain public; registry authority defaults to deny.

Normal Skill CLI and Skill MCP output is concise semantic text. JSON is available only through the
explicit CLI format switch. Runtime MCP exposes agent-oriented views, never RPC data.

## Persistence

The current SQLite schema is created directly and can be deleted and reseeded. There are no
migrations and no compatibility layer.

The seven persisted Plan/attempt resources are:

1. Plans;
2. Plan revisions;
3. Sessions;
4. compiled Checks;
5. attempts;
6. Facts;
7. Check snapshots.

The same current schema also stores six internal registry record families that are not new
agent-facing product resources:

1. immutable Skill release claims;
2. verified distribution links;
3. release authorizations;
4. deployment authorizations;
5. environment deployment selections;
6. renewable deployment announcements.

Published Procedures and their embedded Operations are immutable records. SQLite stores follow the
persisted resources rather than mirroring every table mechanically. The Awilix-injected database
driver is a singleton.

The schema must enforce one open Session per Plan, unique logical Check URI per Plan revision,
unique `(check_uri, compiled_digest)` snapshots and idempotent Fact ingestion.

## Excluded concepts

The active model contains no public or private resource named Proof, Evidence or Binding, no SQL
per requirement, no procedure-specific server rule, no `checks.refresh`, no client-built reference
and no compatibility adapter to either legacy generation.
