---
name: trust
description: Execute semantic TRUST Checks with the packaged generic Runner. Use when an agent is following or resuming a TRUST Plan, receives a trust:// Check URI, needs to execute the next actionable Check, or must understand a TRUST refusal or checklist verdict.
---

# TRUST

Execute one TRUST invocation URI with the bundled Runner:

```text
node <absolute-skill-directory>/scripts/run.js 'trust://...' --json
```

Pass exactly one URI supplied by `trust_plan_read` or by a previous Runner result under
`next.checks[].checkUri`. Do not reconstruct the Operation, run its commands separately,
fabricate Facts, or infer Plan progress from command output.

Before acting on a Check, respect both lists in its `actionScope`: `authorized` and `forbidden`.
They are present on a Plan read and on every Check supplied by `next`; global Procedure boundaries
and boundaries for that exact Check are combined.

When the Plan displays `INTENT CHAINING`, use the invocation URI template shown for the selected
Check. Replace `{intent}` with the exact `Current intent`. A Runner continuation already contains
that encoded current intent. For a continuing Check, replace `{nextIntent}` with one concise,
trimmed, single-line declaration of what will be done by the next Check. Each value must contain 1
to 1024 characters and no control character. URL-encode replacement values. For the final Check,
use the final URI and omit `nextIntent`. These query parameters carry the rotating agent intention;
the opaque Check URI before `?` remains the Check identity.

The first `trust_plan_read` starts the chain. Reading again returns the same current intent and never
restarts it. When resuming a Plan, always read it first and continue from the returned current
intent. The first admitted invocation binds that intent to its Check. Until `VALIDATED`, Plan reads
expose only that Check while its Attempt is pending, and another attempt key is refused. A
`VALIDATED` result advances the chain to the declared `nextIntent`; `NOT_VALIDATED` preserves the
current intent but releases the resolved Attempt reservation. When declarations reopen a completed
Plan, the next Plan read starts a fresh chain.

Treat the Runner's `result` section as authoritative:

- `COMPLETED` means the Operation ran and TRUST accepted its Facts.
- `VALIDATED` means the Check is now satisfied.
- `NOT_VALIDATED` means the Check remains open and the current intent does not change; the Attempt reservation is released. Either address the reason within the authorized scope and retry, or declare escalation with the runtime MCP tool `trust_check_escalate`.
- `REFUSED` means no Operation ran and the current intent does not change.
- A Runner error does not establish or qualify the Check.

The CLI exits successfully whenever it emits one of these structured results, including
`NOT_VALIDATED` and `REFUSED`. A non-zero process status means that no authoritative Runner result
was produced because invocation validation or a technical phase failed. Always read the JSON result;
never infer the checklist outcome from the process status.

Then follow its `next` section:

- `RUN_CHECKS`: choose one supplied Check and run its `checkUri`; its `name`, `successReason`, and
  `actionScope` re-establish the business context and its limits.
- `RETRY_OR_ESCALATE`: address the reason within scope and retry the supplied Check, or declare the
  escalation described below.
- `COMPLETE`: stop; the Plan is complete.
- `READ_PLAN`: call `trust_plan_read` with the Check URI to resynchronize before acting.

Use `trust_check_read` only when the refusal or latest qualification needs more detail.

Escalation is a planned exit from the Procedure, not a Runner failure. Call `trust_check_escalate`
only after the current Check's latest accepted Attempt is `NOT_VALIDATED`. Pass the `attemptHandle`
returned in that Runner result, together with both mandatory prose fields:

- `blockingReason`: why this Check cannot continue within its authorized scope;
- `forbiddenFurtherAction`: the action that could continue the work but that you deliberately do not
  perform because the applicable Procedure scope forbids it.

Use the Plan's `escalatable` projection rather than an older negative Snapshot. A newer pending,
interrupted or differently finalized Attempt makes escalation unavailable. The completed Attempt's
Session does not need to remain open for this declaration.

An accepted escalation changes the Plan to `ESCALATED`. It creates no Fact, Snapshot, verdict or
qualification, preserves the current intent, and stops every further Check admission. Do not call the
Runner again. Only the operator RPC/UI surface can resume the Plan; after that manual action, read the
Plan and continue with the preserved intent. V1 does not define a separate operator identity model.

Read [references/results.md](references/results.md) only when handling a refusal, retry, transport
failure, or `NOT_VALIDATED` verdict.
