# Execute and coordinate

## Prerequisites and outcome

The runtime, published Procedure, chosen Environment and packaged Runner must be
available. You need authority for the Procedure's external actions and its scope.
The outcome is TRUST's explicit current Plan state and Check results, not a worker
claim of completion. Read the [Runner instructions](../../assets/skills/trust/SKILL.md)
before live execution.

## Steps

1. If assigned an existing Plan, skip engagement and read it. Only an authorized
   coordinator engages with `trust_plan_engage`: exact `procedure`, `procedureVersion`, unique
   `plan`, `environment`, and the closed `rootInputs` object. Optional metadata is
   immutable presentation metadata, not execution input. Do not infer root inputs
   from role names; read the compiled Procedure.
2. Read with `trust_plan_read` using either `{ plan }` or `{ checkUri }`, not both.
   Use the returned child Plan identifiers for invocation-only Plans. Never
   fabricate a Check URI when a Plan has only Invocations.
3. Read scope, blockers, current intentions and missing declarations. If needed,
   `trust_plan_declarations_replace` takes `plan`, `expectedRevision` and the
   complete `declarations` snapshot. On revision conflict, read again.
4. Give the Runner only the supplied Check invocation URI. Follow the returned
   intent template exactly; do not share intentions between parent and child
   Plans, run embedded commands yourself, or submit invented live Facts.
5. Interpret `result` and `next`. `COMPLETED` with `VALIDATED` satisfies the Check;
   `COMPLETED` with `NOT_VALIDATED` leaves it open. `REFUSED` is not execution.
   Follow the supplied continuation and reread when it requests `READ_PLAN`.
6. After the latest accepted `NOT_VALIDATED` attempt, either correct within scope
   and retry or use `trust_check_escalate` with the returned `checkUri`,
   `attemptHandle`, `blockingReason` and `forbiddenFurtherAction`. Operator
   resumption uses the actual escalated Plan and current escalation identity.
7. After resumption, read that Plan again. The intention is preserved; resumption
   neither supplies Facts nor satisfies the failed Check. Finish dependent work
   and inspect the root Plan's final state.

## Two examples

In [Dragon Heist](dragon-heist.md), the host assigns the root and child
Plans to agents, while TRUST governs each Check. The extension displays recorded
game state separately from qualification.

For a reusable software-work example, read the complete
[coordination delegation methodology](../../extensions/coordination/DELEGATION.md).
The coordinator persists the mission through its governed Check before dispatching
the worker. The worker claims and submits through the Runner. The coordinator
reviews the response and performs the final observation. Publishing a response
alone does not complete its Plan. A host task launched outside this Procedure
does not automatically become a coordination mission.

## Failure handling

Do not modify, patch, reimplement or bypass the supplied Runner to unblock a Check.
Use the escalation path when the latest accepted attempt is eligible. If a Runner
defect, refusal or transport failure leaves no admissible `NOT_VALIDATED` attempt,
report the blocker to the operator or coordinator instead: do not invent an attempt
handle or Facts to make `trust_check_escalate` accept it. Suspected Runner maintenance
requires a separately authorized task, not an execution workaround.

A child escalation blocks dependent work, not unrelated branches. Read the
ancestor's reported descendant escalations and follow the origin Plan instead of
resuming the ancestor by guesswork. Multiple active escalations remain distinct.

After a transport error, inspect the current Plan and Check before repeating an
external action. A lost response may hide accepted Facts or finalization. Do not
reset a runtime or edit its database to unstick a workflow. Changed mission scope
does not authorize rewriting immutable root inputs; use the coordination guide's
replacement-Plan process when applicable.

Detailed reference: [agent execution and results](../../packages/trust-ui/src/docs/content/en/plans/agent.mdx).
