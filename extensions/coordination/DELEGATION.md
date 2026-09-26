# Delegating work through the coordination extension

This is the operational path used to delegate TRUST work through TRUST itself.
The host starts the worker; TRUST does not spawn an agent. The external coordination
database persists the mission and the Runner executes its governed transitions.

This methodology belongs to the coordination integration, not to the generic TRUST
engine. See [the extension setup](README.md) for installation and lifecycle.
Commands below run from the repository root.

## Verification-bearing implementation missions

For authorized implementation work requiring observed tests, use
`agent-delegation@1.1.0`, authored in
[`agent-delegation-verified.feature`](../../assets/procedures/agent-delegation-verified.feature).
The original `1.0.0` remains immutable and retains its response-only semantics.
Existing Plans do not acquire the new gates automatically.

Read the [verification contract and limits](../../docs/verification/abac/delegation/README.md)
and its [engagement example](../../docs/verification/abac/delegation/engagement.example.json).
Alongside the original mission roots, engage a distinct `reviewer` and three
immutable JSON-string contracts: `unit verification`, `integration verification`,
`database verification`. Each binds requirement IDs to exact test names/files and
the source plus executed artifact closure. These tests need explicit task
authorization; the ABAC delegation implementation authorized all three layers.

The worker claims, implements and executes all three `verify` Checks using the
supplied Runner URIs. `coordination.verification-run@1.0.0` launches actual Node
test processes; a completed response, global exit status or authored report cannot
replace the named results. Missing/failed/skipped/crashed tests and stale bytes do
not qualify. Review Checks appear only after upstream digests are materialized.

The worker then hands over to the independent coordinator. That coordinator must
inspect the assertions, real service/database targets, build provenance and
declared source/artifact closure before executing all three `review` Checks.
Those Checks repeat the tests against the worker's observed digests. The named
reviewer is a procedural host boundary, not authenticated identity in the current
runtime. Do not let a worker execute its own review Checks. After review, the
worker may submit its response; final observation remains the coordinator's job.

If code changes after a satisfied live verification, create a linked replacement
mission and repeat verification. Do not reset live Checks or change immutable
contracts. Labels such as `database` do not certify test quality: real assertions
and independent review establish what was actually checked. Hashing `dist` and
source records both states but does not by itself prove their build relationship.

The new Operation requires Environment `workspaceRoot` at the exact authorized
checkout, alongside the existing coordination database configuration. Installation
configuration changes need their own authorization; a worker must not silently
edit a shared Environment to make verification run. The sections below describe
the original persisted mission transitions, also reused by `1.1.0` around its new
verification and review gates.

## MCP access and the host boundary

Use native TRUST MCP tools when they are loaded in the agent session. In the current
dogfooding session, native discovery was unavailable, so the coordinator used the
repository's public MCP HTTP helper. This is the same server MCP boundary, not a
replacement coordination protocol. The public RPC helper was also used for precise
Plan reads; both surfaces call the shared runtime services.

Starting a host worker is a separate host action after the mission is persisted.
Neither the MCP helper nor the extension starts a worker automatically. Always tell
the worker which live Plan to read, give a returned Check URI when its MCP reader
requires one, and identify its exact assignment. A host task identifier alone is
not a TRUST delegation.

## Preconditions

- The local runtime and its coordination Environment are running.
- `agent-delegation@1.0.0` and its Operations are published.
- The packaged Runner can reach the runtime and the configured PostgreSQL service.
- The coordination extension is prepared and started for the Kanban view.

Do not reset the shared database or restart services merely to dispatch work.
The host agent and worker must have explicit, non-overlapping implementation scopes.

## Coordinator: persist before dispatch

1. Prepare the exact mission request. Use `trust_plan_engage` with the Procedure,
   version, environment, unique Plan identifier, presentation metadata and the
   compiled root inputs: `mission`, `assignee`, `project`, `instructions`,
   `expected`, `authorized`, `forbidden`.
2. Read the Plan using `trust_plan_read` with the returned Check URI. This starts
   the intention chain. Never invent a Check URI or reuse an old current intent.
3. Run the supplied `create mission` Check using the packaged Runner. Supply the
   exact current intent and an announced next intent through the invocation URI.
4. Require `result.status = COMPLETED` and `qualification.verdict = VALIDATED`.
   Engagement alone does not create a PostgreSQL mission or a Kanban card.
5. Start or resume the assigned host worker. Include the Plan reference, scope,
   Runner instructions and ownership boundaries. Record the actual dispatch, not
   merely an intention to dispatch.

The local MCP helper calls the real public endpoint:

```sh
node environments/trust-test/scripts/mcp-call.ts trust_plan_engage @request.json
node environments/trust-test/scripts/mcp-call.ts trust_plan_read '{"checkUri":"<returned-check-uri>"}'
node packages/trust-runner/dist/skill/trust/scripts/run.js '<supplied-invocation-uri>' --json
```

The placeholders above must be replaced with values supplied by TRUST. Credentials
belong to the configured Environment/Runner setup, not to the request or report.

## Worker: claim, implement, submit

1. Read the live Plan and its authorized/forbidden scope before resuming.
2. Execute `claim mission` through the Runner and inspect its qualification.
3. Perform the authorized work. Preserve unrelated changes. Use only public
   acceptance tests and report actual execution results and limitations.
4. Read the current revision and replace the complete agent-declaration snapshot
   through `trust_plan_declarations_replace`: `response` is the report text and
   `outcome` is the supported external completion outcome. These declarations are
   not Facts and do not themselves complete the mission.
5. Read the newly actionable Check and execute `submit response` through the
   Runner. Leave `observe completion` to the coordinator.

Never execute an Operation's SQL directly to claim or complete a mission. Never
fabricate Facts, infer qualification from a successful shell exit, or silently
expand a persisted mission's scope.

## Coordinator: review and integrate

Read worker status and reports rather than assuming that a previously running
worker is still active. Independently review the delivered changes, validate their
public integration paths and resolve ownership conflicts. Execute the final
`observe completion` Check only when the worker response is ready to be observed.
The Procedure proves that the completed response is persisted; independent review
is still required to judge its contents.

Activate changed code explicitly after validation. A remote UI rebuild requires
a browser reload; server changes require a controlled restart. Preserve existing
data and runtime configuration. Commit and publication need separate authorization.

## What appears live

- The card appears after `create mission` is validated.
- The external mission state changes after claim and response submission.
- Board completion and blocking follow the linked Plan: only `COMPLETE` places a
  card in Completed, and only `ESCALATED` places it in Blocked. A submitted response
  remains In progress while the coordinator observation is open. Missing Plan
  projections are shown separately, not inferred from the external response.
- Authorized Plan projections supply current and announced next intentions and
  qualified Check counts. Intentions are declarations, not a CPU activity signal.
- Extension and Plan change notifications trigger rereads; notifications are not
  the source of truth. Database changes can have polling latency.
- Filters can hide a mission. A bare Plan or a worker launched outside this
  procedure does not automatically become a coordination card.

## Changed instructions and interrupted work

Read before retrying; use the returned current intent and revision. Refusals and
transport failures are not completed attempts. Follow the Runner skill's retry
and escalation rules; do not translate an interruption into success.

If the product owner changes the scope after engagement, do not silently rewrite
immutable inputs. Engage a clearly named replacement Plan and explicitly identify
which one the worker must follow. A superseded Plan that has not executed creation
has no external mission; it may remain visible in the core Plan inventory. Do not
pretend it was completed or remove it through direct database edits.
