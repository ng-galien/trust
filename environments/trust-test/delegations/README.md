# Delegating the first TRUST mission

This is a working recipe for one trusted local coordinator and one agent. The host dispatches the agent; TRUST does not start processes or transport agent messages.

The Procedure is `assets/procedures/agent-delegation.feature`. Its four Operations call the external PostgreSQL business functions in `manifests/postgres/002-missions.sql`. No delegation-specific rule was added to the runtime.

## Responsibilities

| Stage | Actor | Persisted result |
| --- | --- | --- |
| Engage and create mission | Coordinator, through MCP then runner | Immutable request, assignment, project, expected result and scope |
| Dispatch | Host agent framework | Worker receives the returned actionable Check URI |
| Claim mission | Worker, through runner | Assigned owner and claim event; returned database instructions |
| Do the bounded work | Worker | No implied qualification; obey the persisted scope |
| Declare and submit response | Worker, through MCP then runner | Revision-checked declarations, immutable database response and outcome |
| Observe completion | Coordinator, through runner | TRUST qualifies the observed completed response, or returns NOT_VALIDATED for a blocker |

The Plan intentionally has three materialized Checks initially. The response Check appears after the agent declares `response` and `outcome`. This does not erase creation or ownership qualification. Every invocation carries the Plan's current intent and, unless final, the next intent.

`completed` means the worker produced and stored its response. It does **not** prove that its analysis is correct or approve an implementation. Add an independent review Procedure when that is the business requirement. `blocked` is a valid submitted response; the final observation remains NOT_VALIDATED and the coordinator declares escalation using its latest attempt handle.

## Local setup

Run from the repository root. PostgreSQL must already be running in the retained `kind-trust-test` environment. Install the additive business schema without restarting its pod or removing existing state:

```sh
kubectl --context kind-trust-test -n trust-test exec -i deployment/postgres -- psql -U flowlab -d flowlab -v ON_ERROR_STOP=1 < environments/trust-test/manifests/postgres/002-missions.sql
kubectl --context kind-trust-test -n trust-test port-forward deployment/postgres 15432:5432
```

Keep that port-forward running in its terminal. In another terminal:

```sh
npm run package:skill --workspace=@trust/runner
TRUST_SERVER_STATE_DIRECTORY=.trust/dogfood TRUST_SERVER_TMUX_SESSION=trust-dogfood-backend TRUST_WEB_TMUX_SESSION=trust-dogfood-frontend node environments/trust-test/scripts/server.ts start --web
TRUST_COORDINATION_DATABASE_URL=postgresql://flowlab@127.0.0.1:15432/flowlab node environments/trust-test/scripts/delegation-install.ts
```

The manager retains the runtime in tmux and stores its SQLite history separately in `.trust/dogfood/runtime.sqlite`. The interface is `http://127.0.0.1:4173/plans`; the MCP endpoint is `http://127.0.0.1:4318/mcp`. The installer configures the `coordination` Environment and publishes through MCP from the repository Operation catalog.

The runner obtains PostgreSQL credentials from its process environment. Set `PGPASSWORD` to the existing local test database password when running Checks; never put a password in a Plan, Operation, URL, or metadata. `TRUST_URL` can override the MCP helper endpoint; configure `TRUST_RPC_ENDPOINT` and `TRUST_OTLP_ENDPOINT` consistently for the runner when using other ports.

## First mission and subsequent missions

`first-delegation.json` records the exact first real request. Its identifiers belong to that retained run. For another delegation, copy the request to a new file and choose a **new** Plan and mission identifier, assignment, title, instructions and scope. Do not overwrite the first mission or reuse it for different work.

```sh
node environments/trust-test/scripts/mcp-call.ts trust_plan_engage @environments/trust-test/delegations/first-delegation.json
```

1. Read the Plan through `trust_plan_read` with a returned Check URI. Run `create mission` with the packaged runner and the supplied intention template.
2. Dispatch the worker with the returned `claim mission` Check URI, the local MCP endpoint and the absolute packaged runner skill path. Do not hand it SQL or an unrestricted database client.
3. The worker reads the Plan, claims the mission, checks the explicit VALIDATED result, and reads the persisted request from `result.actionOutcome.mission.result`.
   If that result is lost after claim, a new client holding the Check URI calls `trust_plan_read` first. Its `ENGAGEMENT CONTEXT` restores the exact immutable root business inputs: instructions, expected result, assignment, project and scope. These are the inputs recorded at engagement, not newly observed PostgreSQL Facts. Preserve the returned current intent, complete the missing declarations, and use the supplied invocation template for the next actionable Check. Do not replay a satisfied claim to recover its output.
4. After doing the work, it reads the current revision and calls `trust_plan_declarations_replace` with the complete declaration snapshot: `response` (the report) and `outcome` (`completed` or `blocked`). It then reads and runs the newly materialized `submit response` Check. Large reports can be supplied to the MCP helper with `@file` instead of shell quoting.
5. The coordinator reads the Plan and runs `observe completion`. On NOT_VALIDATED, use `trust_check_escalate` with the returned attempt handle and the actual blocker. Do not convert a worker's blocker into completion.

Runner invocation:

```sh
node /absolute/repository/packages/trust-runner/dist/skill/trust/scripts/run.js '<TRUST invocation URI>' --json
```

Read the packaged `SKILL.md` for URI templates, intention chaining and escalation. A zero CLI exit is not a VALIDATED verdict. Resume the same Plan after transport failure and let the runner re-observe; database create, claim and identical response submission are replay-safe. A conflicting request or replacement response is refused. Do not reset the Plan to hide a failed attempt.

After a persisted `blocked` response, recovery work belongs to a **new successor mission with new Plan and mission identifiers**. Record the predecessor identifier in the successor instructions or metadata, describe the newly authorized recovery scope, and follow the normal create/claim/submit workflow. Keep the original blocked response and its escalation history immutable; resuming the old Plan does not permit replacing that response.

## Public acceptance

After setup, with the runner's PostgreSQL credentials in the environment:

```sh
TRUST_COORDINATION_DATABASE_URL=postgresql://flowlab@127.0.0.1:15432/flowlab node --test environments/trust-test/scripts/delegation.acceptance.test.mjs
TRUST_COORDINATION_DATABASE_URL=postgresql://flowlab@127.0.0.1:15432/flowlab node --test environments/trust-test/scripts/delegation-recovery.acceptance.test.mjs
```

The two tests exercise live MCP, RPC reads, the packaged runner, OTLP and PostgreSQL: completion, blocked response and escalation, premature admission without a database write, declaration revision conflict, retained prerequisites, database replay, wrong assignment and response immutability. They retain uniquely named acceptance Plans and mission events for inspection. Without the database URL they explicitly skip; skipped tests are not evidence.

The additional recovery acceptance discards the successful claim output and starts a new MCP client process with only the Check URI and transport endpoint. It checks exact engagement-context recovery (including multiline text), uses MCP-rendered intent templates through submission and final completion, and verifies the PostgreSQL request, response and event sequence. It never reads an RPC Plan DTO. Run against an isolated runtime by setting `TRUST_URL`; configure that runtime with its own temporary SQLite database and a separate port, then install the same repository definitions with `delegation-install.ts`. The shared runtime need not restart.

## Traceability and limits

- Plan annotations correlate the mission, project and canonical host agent name. Session, Check, attempt, Fact, qualification and intent history remain owned by TRUST. PostgreSQL retains the immutable request/response and ordered creation, claim and outcome events.
- The agent name is a trusted-host declaration, **not authentication**. Multiple callers sharing it are not isolated. This recipe does not add multi-tenant access control or constrain capabilities outside the runner.
- Authorized and forbidden prose governs the worker's work; it is not a new executable filesystem or browser permission policy.
- The existing test PostgreSQL deployment has no persistent volume. Mission data survives client/runtime restarts, **not pod replacement**. SQLite and PostgreSQL must both be retained for a complete history. Do not use this environment as the only copy of important ongoing work.
- Worker dispatch and recovery remain host responsibilities. There is no inbox listing, recursive delegation, automatic relaunch, or Myri connector in this slice.
- The A3 Maket functional model could not be updated in this run because its MCP tools were unavailable. The model still needs alignment with this first concrete delegation recipe.
