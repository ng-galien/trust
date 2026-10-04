# Execute and coordinate

## Prerequisites and outcome

The runtime, published Procedure, chosen Environment and packaged Runner must be
available. You need authority for the Procedure's external actions and its scope.
The outcome is TRUST's explicit current Plan state and Check results, not a worker
claim of completion. Read the [Runner instructions](../../assets/skills/trust/SKILL.md)
before live execution.

## Determine your role

Use the assignment to identify whether you execute one Plan or coordinate its
children. Do not assume coordination authority because a Plan has Invocations.
If assigned a child, keep execution and completion reporting within that child.
Read ancestors only when needed to understand a reported blocker.

## Execute the assigned Plan

1. If assigned an existing Plan, skip engagement. If explicitly tasked with
   engagement, use `trust_plan_engage` with exact `procedure`, `procedureVersion`,
   unique `plan`, `environment`, and the closed `rootInputs` object. Read the
   compiled Procedure for inputs; do not infer them from role names. Optional
   metadata is immutable presentation metadata, not execution input.
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
   `attemptHandle`, `blockingReason` and `forbiddenFurtherAction`. After accepted
   escalation, stop executing that Plan and report its identity and blocker.
   Only the operator resumes it through the operator surface.
7. If assigned to resume after operator intervention, read that Plan again and
   continue from its preserved intention. On `COMPLETE`, stop and report the
   assigned Plan's result. A worker does not continue into its parent's Checks.

## Coordinate within the assignment

Read the parent Plan's returned child identifiers, state and blockers. Dispatch
children through the host only when dispatch is authorized. Give each worker its
assigned Plan identifier, scope and Runner instructions. Do not invent Check URIs
for invocation-only Plans or reuse a parent's intention in a child.

Use TRUST's current child and parent states to decide what can run; a worker
report alone does not satisfy an Invocation. Continue independent work only within
your assigned scope. For descendant escalation, report the originating Plan and
current escalation identity to the operator. Resume dependent execution only after
the operator has resumed that Plan and TRUST reports it actionable.

Stop when the assigned parent is complete or no authorized work is actionable.
Report its current state and unresolved child blockers. Inspect the root's final
state only when the root is your assigned coordination responsibility.

## Declared child Procedures

Use this path only when the assigned orchestration Procedure exposes mission
collections and you are authorized to declare work. Read the parent Plan. Use
`trust_plan_declarations_replace` with the current revision, scalar `declarations`,
and `missionDeclarations` keyed by the authorized collection names.

Supply each mission with a stable `id`, `rootInputs`, and one `definition`:

- `published`: `reference` identifies an installed Procedure with a SemVer selector.
- `inline`: `procedureSource` and `operationSources` contain canonical DSL sources.
  Put the task scope, stopping instructions and qualification criteria in these
  definitions. Inline content is compiled, not published into the reusable catalog.

Retain accepted mission IDs, definitions and inputs unchanged when adding work.
Omit `missionDeclarations` when preserving the existing collection without changes.
TRUST pins the complete composition on acceptance; identical resubmission does not
select newer catalog versions. After rejection, inspect the Plan and report any
partial creation as a failure instead of treating the declaration as accepted.

Read the resulting child Plan. When host dispatch is authorized, pass its identifier
to the assigned agent; declaring work does not launch an agent. Follow the
coordination instructions above to observe its progress.

Do not remove or replace accepted missions to bypass a blocker. Use the existing
escalation path when admissible; otherwise report the blocker to the coordinator.
Inline sources and their resolved definitions remain in persistent Plan history.

## Select extension-specific instructions

Native mission collections create child Plans before host dispatch. The child
Plan already owns the assignment and agent declarations; do not create an
external mission, claim or response record to mirror it. The host assigns that
Plan to its worker. TRUST qualifies Checks and imports returned Results.

Read [Dragon Heist](dragon-heist.md) only for a requested game demonstration or
when its nested Plan example is needed. Do not execute it to validate an unrelated
assignment.

## Controlled language refusals

When the Plan shows a `CONTROLLED LANGUAGE` block, TRUST controls the
`nextIntent`, the `blockingReason` and the `forbiddenFurtherAction` at the call.
A text that breaks a rule is refused with the reason `controlled-language`, and
nothing changes. Read each finding in the Runner `result.findings` or in the
escalation refusal. Rewrite the text and call again. The reason
`controlled-language-unavailable` means that TRUST cannot run the control. Report
it to the operator or coordinator instead of retrying unchanged. The
[controlled language reference](../../packages/trust-ui/src/docs/content/en/language/procedures/controlled-language.mdx)
gives the rules and the fields.

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
does not authorize rewriting immutable root inputs; declare a separate mission with its own Plan when the scope changes.

Detailed reference: [agent execution and results](../../packages/trust-ui/src/docs/content/en/plans/agent.mdx).
