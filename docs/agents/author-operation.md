# Author an Operation

## Prerequisites and outcome

Read the [Operation reference](../../packages/trust-ui/src/docs/content/en/language/operations.mdx)
and the external system's actual contract. Identify the action, its permissions,
Input, Environment values and the complete Produced schema. The outcome is a
compiled and verified draft, published under a new version only when authorized.

## Steps

1. For an edit, read the complete target source. For a new Operation, use the
   canonical reference and inspect an existing source only when it clarifies the
   required step type. The [controlled file read](../../assets/operations/file.smoke-signal-read.feature)
   is an optional file example; [turn-runes](../../assets/operations/dragon-heist.turn-runes.feature)
   is an optional HTTP projection example.
2. Separate business Input from Environment configuration. Do not embed credentials
   in the source, Plan inputs, public reports or browser properties. Declare every
   Produced field needed by the contract, not only fields used by one qualification.
3. Author the step and JSONata projection against the actual external response
   and declared Produced types. Make required conversions explicit; preserve the
   authored contract when editing an existing Operation.
4. Call `trust_operation_compile` with `source` containing the full file and an
   optional `sourceName`. Inspect the returned diagnostic or compiled interface.
   Compilation neither publishes nor executes the Operation.
5. Use `trust_operation_simulate` with `source`, `input`, `environment` and `steps`.
   These are explicit simulated step results, not externally observed Facts. Follow
   [verification](verify-and-test.md) for positive, negative and malformed cases.
6. When live testing is authorized, discover compatible Environments with
   `trust_operation_environment_list` using either `{ source }` or
   `{ operation, version }`. Start a Trial with the same alternative plus
   `environment` and `input`; never send both source and catalog identity.
7. If publication is authorized and the draft has been reviewed, publish it. `trust_operation_save` takes `source` and `sourceName`;
   despite its name, it stores a published immutable catalog version. Select a new
   version and unused source filename. Read it back with `trust_operation_read`
   using the exact `operation` and `version`.

## Optional example: controlled signal

Load the complete linked file-read source into `source`. For simulation, add:

```json
{
  "input": { "expectedSignal": "ready" },
  "environment": { "workspaceRoot": "/absolute/disposable/workspace" },
  "steps": { "signal": { "content": { "signal": "ready" } } }
}
```

The projection produces `signal` and `expectedSignal`, both `"ready"`. Change
only the simulated signal to `"blocked"`: projection should still produce a
valid object. It is the [Procedure](author-procedure.md), not this Operation,
that determines whether those values satisfy a Check.

## Failure handling

Repair compiler diagnostics in the draft, not the published source. A projection
that omits a required Produced field is invalid; do not weaken the schema to make
one test pass. A Trial executes real external actions outside any Plan and cannot
prove Check qualification. Read its report with `trust_operation_trial_read`
(`trial`, optional `after`); cancellation is `trust_operation_trial_cancel`
(`trial`) and does not undo completed external actions.

The discoverable `trust_operation_remove` tool does not permit deleting a
published version. Do not use deletion and republication to evade immutability.

Public verification reference: [MCP authoring acceptance](../../packages/trust-runtime/acceptance/mcp-authoring.acceptance.test.ts).

## Stop and report

For authoring, return the draft source, compilation and verification results, and
remaining diagnostics. Stop before publication unless it is part of the authorized
task. For publication, read back the exact new version and report its identity.
Do not engage a Plan or start additional live actions to demonstrate completion.
