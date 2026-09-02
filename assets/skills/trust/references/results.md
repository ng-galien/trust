# Runner results and recovery

The CLI returns process status `0` whenever it emits a structured Runner result. This includes
`COMPLETED/VALIDATED`, `COMPLETED/NOT_VALIDATED`, and `REFUSED`. The `result` section describes what
happened; `next` says what the agent can do without another Plan read. A non-zero process status is
reserved for an invalid invocation or a technical failure that prevented such a result.

## `COMPLETED` and `VALIDATED`

The external Operation ran, TRUST accepted the complete Fact batch, and the Check is satisfied in a
new Plan revision. Follow `next`: it either supplies newly actionable Checks or declares the Plan
complete. Read the Plan only when `next.action` is `READ_PLAN`.

## `COMPLETED` and `NOT_VALIDATED`

The external Operation ran and TRUST accepted the complete Fact batch, but a compiled qualification guard
did not satisfy the Check. Use `result.qualification.reasonCode`, `result.qualification.reason`, and
`result.actionOutcome` to address the observed condition. Do not reinterpret the outcome as Plan
progress. An intent chain does not advance.
The resolved Attempt releases its reservation. `next.action` is normally `RETRY_OR_ESCALATE` and
supplies the Check `name`, `successReason`, `checkUri`, and existing `actionScope` with that unchanged
current intent.

Retry only within the Check's displayed authorized scope. When the observed blocker cannot be
resolved there, call the runtime MCP tool `trust_check_escalate` with the `attemptHandle` from this
Runner result and mandatory `blockingReason` and `forbiddenFurtherAction`. The latter names what could continue the work but is deliberately not
performed because the Procedure scope forbids it. An accepted escalation stops the Procedure and
preserves this negative qualification and the current intent until an operator resumes the Plan.

## `REFUSED`

The Runner did not execute the external Operation. TRUST returns the `READ_PLAN` continuation with
the refusal; the Runner transports it as a structured, non-error MCP result. Follow the reason and
that continuation.
Common causes are an already changed Plan revision, blocked prerequisites, an unavailable
Session, or a Check URI that is no longer current. For an intent-chained Plan, `intent-required`,
`intent-invalid`, `intent-mismatch`, `intent-in-use`, `next-intent-required`, and
`next-intent-unexpected` mean the invocation did not match the chain shown by the latest Plan read,
used an invalid value (1 to 1024 characters, trimmed, single-line, without control characters), or
selected a different Check after the current intent was bound. Read the
Plan again, preserve its exact current intent, and use the actionable Check and its continuing or
final invocation template as instructed. A refusal never advances the intent chain.

## Runner error

An admission, execution, OTLP, or finalization interruption is not a checklist verdict. Do not emit
Facts manually. Read the Check before retrying. A retry is normal when TRUST rejected an incomplete
Fact batch; the generic Runner may execute the Operation again.

## Configuration

The packaged Runner uses these optional environment variables:

- `TRUST_RPC_ENDPOINT`, defaulting to `http://127.0.0.1:4318/rpc`;
- `TRUST_OTLP_ENDPOINT`, defaulting to `http://127.0.0.1:4318/v1/traces`.

The CLI and MCP runner startup accept repeatable `--path <absolute-directory>` options. Each
directory is appended to the inherited `PATH` for Shell steps; Operations do not redeclare this
standard process configuration.

Operation-specific paths, URLs and other execution values come from the TRUST Environment returned
at admission. Do not inject them into the Skill.
