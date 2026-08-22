---
name: trust
description: Execute semantic TRUST Checks with the packaged generic Runner. Use when an agent is following or resuming a TRUST Plan, receives a trust:// Check URI, needs to execute the next actionable Check, or must understand a TRUST refusal or checklist verdict.
---

# TRUST

Execute one TRUST invocation URI with the bundled Runner:

```text
node <absolute-skill-directory>/scripts/run.js 'trust://...' --json
```

Pass exactly one URI supplied by `trust_plan_read`. Do not reconstruct the Operation, run its
commands separately, fabricate Facts, or infer Plan progress from command output.

When the Plan displays `INTENT CHAINING`, use the invocation URI template shown for the selected
Check. Replace `{intent}` with the exact `Current intent`. For a continuing Check, replace
`{nextIntent}` with one concise, trimmed, single-line declaration of what will be done by the next
Check. Each value must contain 1 to 1024 characters and no control character. URL-encode both
values. For the final Check, use the final template and omit `nextIntent`. These query parameters
carry the rotating agent intention; the opaque Check URI before `?` remains the Check identity.

The first `trust_plan_read` starts the chain. Reading again returns the same current intent and never
restarts it. When resuming a Plan, always read it first and continue from the returned current
intent. The first admitted invocation binds that intent to its Check. Until `VALIDATED`, Plan reads
expose only that Check while its Attempt is pending, and another attempt key is refused. A
`VALIDATED` result advances the chain to the declared `nextIntent`; `NOT_VALIDATED` preserves the
current intent but releases the resolved Attempt reservation. When declarations reopen a completed
Plan, the next Plan read starts a fresh chain.

Treat the Runner result as authoritative:

- `COMPLETED` means the Operation ran and TRUST accepted its Facts.
- `VALIDATED` means the Check is now satisfied.
- `NOT_VALIDATED` means the Check remains open and the current intent does not change; the Attempt reservation is released, so report the reason and address it before retrying.
- `REFUSED` means no Operation ran and the current intent does not change; follow the reason, read the Plan again, and select an actionable Check.
- A Runner error does not establish or qualify the Check.

After each result, use `trust_plan_read` with the Check URI to read the current revision and its next
actionable Checks. Use `trust_check_read` when the refusal or latest qualification needs detail.

Read [references/results.md](references/results.md) only when handling a refusal, retry, transport
failure, or `NOT_VALIDATED` verdict.
