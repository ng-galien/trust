# Repeated Procedures

Status: proposal with unresolved product decisions.

This evolution adds a do-while form of Procedure composition. TRUST completes one invocation of a
Procedure, evaluates an explicit stop condition, and either satisfies the repeated Requirement or
creates the next invocation of the same Procedure.

It builds on `procedure-composition.md` and uses the closed typed expressions from
`typed-condition-expressions.md`.

The sentence is readable and keeps loop control inside TRUST. The main technical difference from
ordinary composition is that the Plan graph grows at runtime and may grow without a product-defined
bound.

## Product semantics

A repeated Procedure is a Requirement containing successive child Procedure instances:

```text
do
  satisfy one invocation of Procedure P
  evaluate stopWhen from its typed Results and bound context
while stopWhen is false
```

The Procedure runs at least once. An iteration advances only after its child Procedure is satisfied.
An open or `NOT_VALIDATED` leaf Check keeps the same iteration active.

The stop decision belongs to TRUST. The agent does not report that the loop should advance or stop,
does not choose the iteration number, and continues to receive ordinary actionable Check URIs.

The loop is incremental, not an eager in-process loop. TRUST creates at most the next required
iteration during one Plan revision transition.

## Grammar

The surface names the stop condition directly:

```gherkin
Then Repeat "deployment observation" invokes Procedure "deployment-observation" version "1.0.0"
    on "deployment" as Input "deployment"
    and stops when result.status = "stable"
    and materializes "stable revision" from Result "observed revision"
    and must establish "the deployment became stable"
```

This is semantically equivalent to `do Procedure while !(stop condition)`.

As with ordinary composition, the exact child version must be selected somewhere in the authored
contract. The inline `version "1.0.0"` form is the smallest surface. If Procedure versions are instead
declared in a dependency section, Repeat must use the same single mechanism as ordinary composition.

**Product owner decision required:** choose the exact-version surface in `procedure-composition.md`;
Repeat inherits it and must not introduce a second mechanism.

## Stop expression

The stop expression may reference:

- `result`: explicit Results of the satisfied current iteration;
- `context`: immutable values bound to this Repeat instance by the parent invocation.

For names that are not identifiers, bracket notation remains required:

```text
result["observed revision"]
context["deployment window"]
```

The expression must compile to a boolean. It cannot read arbitrary runtime state, invoke an external
function, inspect an unqualified Check or access Results from another target or iteration.

`result` denotes only the current completed iteration. Intermediate Results are not accumulated into
the expression context. The context is the bound context of one Repeat instance; it does not combine
values from sibling `on each` instances.

A constant false expression represents a semantically unbounded repeat. Such a Requirement and its
parent Procedure never become satisfied, although every completed iteration remains observable.

## One, each and all scopes

### `on`

`on` creates one Repeat instance from one selected value. It owns one counter beginning at 1.

### `on all`

`on all` creates one Repeat instance whose child `many` Input receives the whole selected collection.
The stop condition is evaluated once per completed iteration of that collection-level instance.

### `on each`

`on each` creates one independent Repeat instance for every selected value and its parent
coordinates. Each instance owns:

- its own current iteration number;
- its own child context and declarations;
- its own stop decisions;
- its own final Result mapping;
- its own later-iteration suffix for cascade.

The instances progress independently:

```text
deployment-a -> current iteration 4
deployment-b -> current iteration 2
deployment-c -> stopped at iteration 1
```

The Repeat Requirement is satisfied only when every required `on each` instance has stopped. A
Scenario satisfaction expression evaluated per target may observe the corresponding scoped Repeat
Requirement boolean only when all referenced Requirement instances have exactly aligned coordinates.

When final Results are mapped into a parent role, each stopped target contributes values with that
target's coordinates. A downstream Scenario that depends on the containing parent Scenario does not
advance until the parent Scenario satisfaction contract is true.

The phrase "every later iteration" means every later iteration of the same Repeat instance and the
same target coordinates, not every iteration of sibling targets.

## Iteration identity and namespacing

Every iteration is a distinct child Procedure instance. Its number participates in the invocation
path and every leaf Check URI.

For `on each`, the target identity precedes or otherwise disambiguates the iteration identity:

```text
.../requirements/deployment-observation/targets/<deployment-a>/iterations/1/...
.../requirements/deployment-observation/targets/<deployment-a>/iterations/2/...
.../requirements/deployment-observation/targets/<deployment-b>/iterations/1/...
```

The exact URI segment order remains the public URI decision identified in
`procedure-composition.md`. Dynamic target values use the same canonical-or-hashed semantic segment
rules as existing expanded Checks.

TRUST must not reopen one Check identity to represent the next pass. Distinct identities preserve:

- the exact external action and observation attempt;
- immutable Facts and Snapshots for each pass;
- idempotency of admission and finalization within one iteration;
- an explicit dependency chain between iterations;
- precise suffix invalidation for one target.

Iteration numbers are deterministic, start at one and increase only after the preceding child
Procedure is satisfied and its stop expression is false. Concurrent finalization must not create two
instances with the same next number.

## Compiled structure

The repeated Requirement extends a compiled Procedure invocation with a typed stop expression:

```ts
interface CompiledRepeatedProcedureInvocation {
  kind: "repeat";
  name: string;
  scenario: string;
  procedure: string;
  procedureVersion: string;
  procedureDigest: string;
  childDefinition: CompiledProcedure;
  target: CompiledTarget;
  inputBindings: readonly CompiledProcedureInputBinding[];
  stopWhen: CompiledBooleanExpression;
  materializes: readonly CompiledResultMaterialization[];
  successReason: string;
}
```

The exact child definition, bindings, Result interface and canonical stop AST participate in the
parent Procedure digest. Runtime iteration instances do not change that immutable definition digest.

Compilation rejects:

- an unknown child Procedure or exact version;
- a stop expression whose type is not boolean;
- a reference outside explicit current Results or bound caller context;
- a Result not guaranteed when the child Procedure is satisfied;
- incompatible Result materialization;
- incompatible target or Input topology;
- a composition cycle independently of repetition;
- an Operation identity conflict under the collision contract selected for composition.

## Plan revision transition

The root Plan revision contains or resolves the Repeat and child instance graph. After the final Check
needed by one iteration is qualified, TRUST performs one transactional transition:

1. recompute the child Scenario satisfaction expressions;
2. keep the same iteration when the child is not satisfied;
3. resolve the explicit Results when the child becomes satisfied;
4. evaluate `stopWhen` against those Results and the bound context of this Repeat instance;
5. when true, satisfy this Repeat instance and expose its final mapped Results;
6. when false, append iteration `n + 1` for this Repeat instance;
7. recompute parent Requirement and Scenario satisfaction;
8. expose the resulting leaf Check actionability.

The next iteration receives the same bound parent Inputs as the preceding iteration in the same
active chain. If upstream parent context is replaced, normal dependency and context-digest rules may
invalidate and rebuild that chain.

A previous iteration Result is not fed into the next iteration implicitly. Stateful feedback would
require an explicit Result-to-next-Input binding contract and is outside this proposal.

## Results

A Repeat may expose Results only after its stop condition is true. The parent receives the explicitly
mapped Results of the final iteration of each stopped Repeat instance.

Intermediate iteration Results remain in immutable Plan history and are available only while
evaluating that iteration's stop expression. They do not accumulate into the parent context.

For `on each`, one target may have a final Result while sibling targets are still running. The runtime
must retain its scoped Result without making a downstream Scenario actionable before the containing
parent satisfaction rule permits it.

An intentionally unbounded Repeat never produces a final parent Result because no Repeat instance
reaches a true stop condition. Its Operations may still act on external systems.

## Agent declarations in repeated children

Ordinary composition permits agent-declared roles inside child Procedures. Repeat must define whether
such declarations are iteration-local or inherited.

Two contracts are possible:

1. **Fresh declarations:** each new iteration starts with its child agent declarations missing. Values
   from an earlier iteration are never copied implicitly.
2. **Inherited declarations:** selected declarations are carried into the next iteration. This
   requires an explicit rule defining which declarations are stable Inputs and how replacement of an
   inherited value cascades through previous and current iterations.

In either contract, declaration identity includes Repeat instance path, target coordinates and, when
iteration-local, iteration number. The current flat object keyed by role name cannot represent it.

Past declarations remain immutable in the revision history. The active declaration representation
must also make it possible to rebuild an older active iteration after requalification.

**Product owner decision required:** choose fresh or inherited declarations. Until this is decided,
Repeat over a child containing `declared by agent` roles is not fully specified. Excluding those
children from the first contract is a third possible scope decision.

## Requalification and cascade

Active Check qualifications remain replaceable under the Plan's re-observation rules. If accepted new
Facts replace a Check qualification in iteration `k` of one Repeat instance:

1. iteration `k` is recomputed;
2. its previous stop decision loses active status;
3. later iterations of the same Repeat instance and target coordinates leave the active Plan graph;
4. sibling Repeat instances remain active unless an explicit dependency crosses to them;
5. mapped final Results from the affected instance lose availability;
6. downstream parent Requirements and Scenarios reopen recursively;
7. Facts, Attempts and Snapshots from removed iterations remain immutable history;
8. the agent resumes from the earliest actionable leaf in the rebuilt active suffix.

If iteration `k` becomes satisfied again and `stopWhen` is true, no later iteration is recreated. If
it remains false, the suffix is rebuilt incrementally through new active qualifications.

The current public runtime permits explicit re-observation of a satisfied Check only in dry-run. The
earlier-iteration requalification acceptance therefore uses dry-run unless a live re-observation
contract is introduced.

Reactivating an old equivalent Snapshot automatically and requiring the agent to re-observe every
rebuilt later Check are different semantics. The current runtime removes affected active
qualifications and requires new finalization; immutable equivalent Snapshots may be deduplicated but
are not automatically reactivated.

**Product owner decision required:** decide whether rebuilt suffixes always require replay or may
reactivate an exact historical qualification when Check digest, context and dependencies are
identical.

## Sessions, failures and replay

All iterations use the root Plan Session. Closing or expiring it blocks admission for the current
iteration without satisfying, cancelling or failing the Repeat. Re-engaging the same Plan identity
opens a new Session and resumes the current actionable leaves.

A refusal, crash, transport interruption or rejected incomplete Fact batch leaves the current Check
and iteration unchanged. The agent may invoke that Check again. Once an iteration advances, the next
iteration has distinct Check URIs and therefore distinct Attempts.

Repeat adds no generic exactly-once guarantee. Operations that cannot safely be replayed after an
unknown external outcome still require explicit human intervention.

No generic timeout, delay, scheduler, backoff or automatic recovery policy is a qualification
semantic. A separate orchestration policy may decide when an agent invokes an actionable Check but
cannot change the stop result.

Whether a maximum iteration count is absent or optionally configurable is a product boundary. A
maximum would change the semantics only if reaching it creates a new terminal outcome; silently
treating it as satisfaction would contradict `stopWhen`.

**Product owner decision required:** confirm that no maximum produces no additional terminal state,
or define the explicit state and verdict when an optional limit is reached.

## Non-bounded revision storage

The current runtime stores a complete Plan revision for every Check verdict:

- `buildPlanRevision` reconstructs the complete current Check list;
- every new revision inserts every current Check again;
- active qualifications are copied to the new revision;
- dependency and read logic scans the current flat Check set.

If all earlier iterations remain in every current revision so that any one can be requalified, a
Repeat of `n` iterations produces a current prefix of size `O(n)` and cumulative duplicated revision
storage of `O(n^2)`. A semantically unbounded Repeat therefore cannot rely unchanged on the current
full-copy revision representation.

Possible persistence contracts include:

1. an append-only iteration and Check-instance ledger with revision validity intervals or deltas;
2. persistent structural sharing between Plan revisions while preserving immutable historical reads;
3. archiving completed iterations outside the active graph and forbidding their later
   requalification.

The third alternative conflicts with the current proposal's earlier-iteration cascade semantics. The
first two retain it but require a replacement Plan store/read model.

Regardless of representation, the runtime must preserve:

- deterministic reconstruction of every historical Plan revision;
- one active status per Check instance in the current revision;
- precise suffix removal;
- immutable Facts, Attempts and Snapshots;
- bounded work for appending one new iteration relative to the size of the changed suffix, rather
  than copying the complete history.

**Product owner decision required:** decide whether arbitrary earlier iterations remain
requalifiable. If they do, the implementation requires a delta or structurally shared persistence
model before Repeat can be described as non-bounded.

## Checklist delta and Runner result

The current Runner returns the finalization verdict with:

```text
newlySatisfied
newlyOpened
unchanged
```

`newlyOpened` currently contains previously qualified Checks invalidated by cascade. It does not
contain newly instantiated Checks. A false stop condition adds the first leaf Checks of iteration
`n + 1`, which cannot be represented distinctly by that contract.

Two public behaviors are possible:

1. the Runner result remains a verdict delta; the agent then calls `trust_plan_read` to discover the
   current actionable Checks;
2. the finalization and Runner contracts are replaced to distinguish at least newly added, removed,
   reopened and newly actionable Checks.

If the second behavior is selected, persisted Snapshot deltas, Plan events, RPC, MCP rendering,
Runner types, UI history and acceptance contracts change together. This is a cross-cutting public
contract replacement, but it does not alter the execution or qualification model.

**Product owner decision required:** choose whether finalization itself must return the next
iteration's actionable Check URIs.

## URI, RPC and MCP consequences

Check admission remains URI-based and needs no Repeat-specific execution endpoint. The runtime must
extend read views with:

- Repeat Requirement identity and local name;
- target coordinates;
- current iteration per Repeat instance;
- completed iteration count;
- stop status and final Result availability;
- invocation breadcrumb for every leaf Check;
- active versus historical suffix membership.

`trust_procedure_read` must follow the composed-source decision in `procedure-composition.md`. A leaf
Check in iteration 15 still belongs to the same immutable child definition as iteration 1; the read
surface should not duplicate source content merely because the runtime instance number differs.

MCP Plan rendering must make independent `on each` loops distinguishable and tell the agent which
leaf Checks are currently actionable without asking it to infer the loop counter.

## Interface consequences

A flat progress ratio of satisfied Checks over total Checks is unstable for Repeat: completing an
iteration may immediately add another iteration and increase the denominator. An indefinitely false
stop condition never reaches 100 percent even though every historical iteration completed.

The interface needs Repeat-specific presentation, including:

- one row or node per Repeat instance/target;
- current iteration and completed iteration count;
- stopped versus active state;
- expansion of historical iterations on demand;
- final Result display only after stop;
- cascade that visibly removes an active suffix without deleting its history.

Whether the primary progress indicator counts root Requirements, active leaf Checks or historical
iterations is a product presentation decision. The underlying read model must expose all three
without conflating them.

**Product owner decision required:** choose the primary progress semantics shown for a Repeat.

## Embedded Operations and Environment

Every leaf iteration Check receives the exact Operation embedded by its child definition. The same
Operation collision decision as ordinary composition applies when different child versions contain
different definitions under one Operation identifier.

Every iteration inherits the root Plan Environment selection. Admission projects only the values
declared by the leaf Operation. Repeat introduces no iteration-specific Environment and no release or
deployment registry.

## Explicit exclusions

Unless one of the open product decisions changes the scope, this proposal does not introduce:

- a Procedure-wide Runner action;
- eager or synchronous infinite execution;
- implicit previous-Result feedback;
- implicit Result accumulation;
- collection correlation by position;
- child Plans, child Sessions or child Environments;
- a generic exactly-once engine;
- a scheduler, delay or retry policy as qualification semantics;
- automatic satisfaction when an operational limit is reached.

## Technical classification

### Blocking contracts

- exact child version selection inherited from composition;
- namespaced Repeat instance and iteration identity;
- independent `on each` loop semantics;
- a runtime Requirement/Procedure instance graph;
- Result and declaration identity per target and iteration;
- precise suffix cascade;
- a persistence model compatible with the selected historical requalification semantics;
- the public behavior after new iteration Checks are instantiated.

### Bounded implementation costs after those contracts are fixed

- stop AST evaluation after child satisfaction;
- deterministic counter allocation inside the existing Plan transaction;
- URI path extension;
- Plan/MCP read projections;
- Runner contract replacement if selected;
- Repeat-specific UI and history views;
- public acceptance coverage.

## Public acceptance evidence

Acceptance coverage must pass through the real compiler, publishing, Plan, RPC, MCP, OTLP, Runner and
interface boundaries. It must cover:

- mandatory execution of the first iteration;
- exact child version and digest embedding;
- a true first stop condition;
- several false conditions followed by a true condition;
- a constant false condition leaving the Repeat and Plan open;
- deterministic iteration and Check URIs;
- independent `on each` targets progressing at different iteration numbers;
- one target stopping without stopping siblings;
- admission, Attempts and Facts isolated by target and iteration;
- final Result materialization only after stop, with target coordinates;
- the selected child declaration lifecycle across iterations;
- Session close, expiry and re-engagement resuming the current iteration;
- `NOT_VALIDATED`, refused and incomplete-Fact attempts not advancing the loop;
- dry-run requalification of an earlier iteration invalidating only its target suffix;
- sibling target preservation during that cascade;
- replay or exact historical reactivation under the selected contract;
- live OTLP Facts and dry-run operator Facts following the same forward loop semantics;
- concurrent finalization creating one deterministic next iteration;
- persisted/read history after an active suffix is removed;
- the selected checklist-delta or mandatory Plan-reread behavior;
- MCP and UI rendering of current versus historical iterations;
- evidence that appending iterations does not duplicate the complete historical prefix under the
  selected non-bounded persistence contract.

## Product decisions still open

Before implementation, the product owner must resolve:

1. the exact child-version surface inherited from composition;
2. fresh, inherited or initially unsupported child agent declarations;
3. replay versus automatic exact reactivation of a rebuilt suffix;
4. whether arbitrary earlier iterations remain requalifiable;
5. the persistence model required by that requalification choice;
6. whether finalization returns newly added/actionable Checks or requires a Plan reread;
7. whether an iteration maximum exists and what explicit terminal outcome it creates;
8. the primary progress semantics displayed by the interface;
9. the URI and composed-source read decisions inherited from composition;
10. whether live re-observation of a satisfied historical Check is introduced.
