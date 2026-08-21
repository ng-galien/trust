# Runner results and recovery

## `COMPLETED` and `VALIDATED`

The external Operation ran, TRUST accepted the complete Fact batch, and the Check is satisfied in a
new Plan revision. Read the Plan again because dependent Checks may have opened or become actionable.

## `COMPLETED` and `NOT_VALIDATED`

The external Operation ran and TRUST accepted the complete Fact batch, but a compiled qualification guard
did not satisfy the Check. Use `reasonCode`, `reason`, and `actionOutcome` to address the observed
condition. Do not reinterpret the outcome as Plan progress.

## `REFUSED`

The Runner did not execute the external Operation. Read the Check or Plan and follow the returned
reason. Common causes are an already changed Plan revision, blocked prerequisites, an unavailable
Session, or a Check URI that is no longer current.

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
