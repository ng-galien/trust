# Declarative execution timeouts

Tracking issue: https://github.com/ng-galien/trust/issues/3

## Problem

A Procedure Check running a long Hall Playwright or PostgreSQL Operation cannot declare its execution limit in the TRUST DSL. Direct Runner Shell commands default to 30 seconds, while Operation Trials default to 5 minutes and pass that value to the Shell runner. Those technical defaults are too short for ordinary software builds.

## Requested outcome

Support `within "<duration>"` and `until "<date-time>"` on a Procedure Check's Operation invocation. The constraint covers the complete Operation. It is not part of the reusable Operation contract.

## Product decisions

- `within` accepts a positive integer immediately followed by `ms`, `s`, `m` or `h`.
- `until` accepts an ISO 8601 date-time with an explicit timezone.
- A Check declares at most one of these clauses, immediately after its Operation reference.
- A live Runner applies the constraint from the start of the complete Operation execution through every step and Produce.
- Operation simulation executes nothing. An Operation Trial has no Procedure Check and therefore retains its independent technical limit. A Procedure dry-run records operator Facts and does not apply an execution timer.
- Without a Check constraint, the Runner Shell and Trial technical defaults are 10 minutes. Host configuration remains a technical fallback, not a competing authored contract.

## Acceptance

- Compile valid durations and reject invalid or ambiguous values at public boundaries; preserve one canonical type authority across compiler, SDK, Runner, LSP and UI.
- Verify that a live Plan Check applies its Procedure-owned constraint and that Trial, Operation simulation and Procedure dry-run do not inherit it.
- Verify a command completing before the deadline and a command exceeding it, including child-process cleanup and useful diagnostics.
- A timeout without accepted Facts must not fabricate a qualification or mark a Check satisfied; preserve the existing interruption and retry contract.
- Reflect the declaration in language assistance, source formatting, effective execution details and English/French documentation with compiling examples.
- Preserve immutable published versions and pinned compositions.

## Implementation direction

- `trust-procedure` owns the compiled constraint and its exhaustive matcher.
- The runtime includes it in live Check admission; it is omitted from dry-run admission.
- The Runner converts it to the effective execution budget and propagates the remaining time to Shell, HTTP and PostgreSQL execution.
- Shell retains SIGTERM followed by SIGKILL after 2 seconds. Its fallback and the Trial limit default to 10 minutes.
- `trust-operation` remains unchanged and context-free.

Raised while validating Hall agenda scheduling with `hall.playwright-test-run` and `hall.postgres-test-run`.
