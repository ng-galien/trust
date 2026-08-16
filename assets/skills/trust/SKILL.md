---
name: trust
description: Execute semantic TRUST Checks with the packaged generic Runner. Use when an agent is following or resuming a TRUST Plan, receives a trust:// Check URI, needs to execute the next actionable Check, or must understand a TRUST refusal or checklist verdict.
---

# TRUST

Execute one semantic Check URI with the bundled Runner:

```text
node <absolute-skill-directory>/scripts/run.js 'trust://...' --json
```

Pass exactly the URI supplied by TRUST. Do not reconstruct the Operation, run its commands
separately, fabricate Facts, or infer Plan progress from command output.

Treat the Runner result as authoritative:

- `COMPLETED` means the Operation ran and TRUST accepted its Facts.
- `VALIDATED` means the Check is now satisfied.
- `NOT_VALIDATED` means the Check remains open; report the reason and address it before retrying.
- `REFUSED` means no Operation ran; follow the reason, read the Plan again, and select an actionable Check.
- A Runner error does not establish or qualify the Check.

After each result, use `trust_plan_read` with the Check URI to read the current revision and its next
actionable Checks. Use `trust_check_read` when the refusal or latest qualification needs detail.

Read [references/results.md](references/results.md) only when handling a refusal, retry, transport
failure, or `NOT_VALIDATED` verdict.
