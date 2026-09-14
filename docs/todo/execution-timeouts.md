# Declarative execution timeouts

Tracking issue: https://github.com/ng-galien/trust/issues/3

## Problem

An Operation running a long Hall Playwright or PostgreSQL command cannot declare its execution timeout in the TRUST DSL. Direct Runner Shell commands default to 30 seconds, while Operation Trials default to 5 minutes and pass that value to the Shell runner. The same Operation therefore receives different time budgets depending on its launch path. Host environment overrides are not a discoverable, versioned execution contract.

## Requested outcome

Support an explicit execution timeout in the authored DSL, with `with timeout` as a syntax direction. Decide the precise owner and scope (Procedure invocation, Operation, or step) before implementation; this issue does not approve competing timeout authorities. The duration should be understandable from the source and effective execution details, with consistent behavior in a Plan Check and an Operation Trial.

## Design decisions to resolve

- Canonical owner, syntax, units, positive bounds and omitted-value behavior.
- Precedence between declared duration and host/Trial safety limits, including how the effective limit is exposed.
- Whether a duration covers one step or the complete Operation; distinguish it from Session expiry, MCP request deadlines and tool-specific deadlines such as Playwright.

## Acceptance

- Compile valid durations and reject invalid or ambiguous values at public boundaries; preserve one canonical type authority across compiler, SDK, Runner, LSP and UI.
- Execute the same declared Operation through a Plan Check and a Trial and verify the documented effective-timeout policy.
- Verify a command completing before the deadline and a command exceeding it, including child-process cleanup and useful diagnostics.
- A timeout without accepted Facts must not fabricate a qualification or mark a Check satisfied; preserve the existing interruption and retry contract.
- Reflect the declaration in language assistance, source formatting, effective execution details and English/French documentation with compiling examples.
- Preserve immutable published versions and pinned compositions.

## Current implementation

- `packages/trust-runner/src/shell/run.ts`: 30-second default, `TRUST_SHELL_TIMEOUT_MS`, SIGTERM followed by SIGKILL after 2 seconds.
- `packages/trust-runtime/src/trial/service.ts`: 5-minute Trial default, `TRUST_TRIAL_TIMEOUT_MS` at server configuration, propagated to Shell execution.
- `packages/trust-operation/src/shell.ts`: no declarative timeout field.

Raised while validating Hall agenda scheduling with `hall.playwright-test-run` and `hall.postgres-test-run`. This issue records the feature request; it does not implement the language change.
