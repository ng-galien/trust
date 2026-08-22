# Runner results and recovery

## `COMPLETED` and `VALIDATED`

The external Operation ran, TRUST accepted the complete Fact batch, and the Check is satisfied in a
new Plan revision. Read the Plan again because dependent Checks may have opened or become actionable.

## `COMPLETED` and `NOT_VALIDATED`

The external Operation ran and TRUST accepted the complete Fact batch, but a compiled qualification guard
did not satisfy the Check. Use `reasonCode`, `reason`, and `actionOutcome` to address the observed
condition. Do not reinterpret the outcome as Plan progress. An intent chain does not advance.
The resolved Attempt releases its reservation, so the next Plan read presents the Checks that may
be attempted with that unchanged current intent.

## `REFUSED`

The Runner did not execute the external Operation. Read the Check or Plan and follow the returned
reason. Common causes are an already changed Plan revision, blocked prerequisites, an unavailable
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

Operation-specific paths, URLs and other execution values come from the TRUST Environment returned
at admission. Do not inject them into the Skill.
