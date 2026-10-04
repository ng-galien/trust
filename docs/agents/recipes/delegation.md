# I want to delegate work and recover its result

Choose a static Invocation when the child method and inputs are known. Reserve a
mission collection when work will be discovered during execution. Neither creates
a host agent: TRUST creates the child Plan; the host dispatches its worker.

## 1. Define what the child returns

Example convention: a context's short description is stored in the Jira issue's
`summary` field. The installed Operation reads that field, **not Jira's separate
description field**. For another required field, adapt the Operation to its actual
API shape. The returned value comes from a qualified observation, not a worker's
final message.

```gherkin procedure
@trust-dsl:1 @procedure:observe-usage-context @version:1.0.0
Feature: Observe the description of one usage context
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the assigned context record. | Edit it or approve product decisions. |
    And one reference "context record"
    And one string "description" returned
  @scenario:observe
  Scenario: Observe the recorded description
    Then Check "read description" runs Operation "jira.issue-read@1.1.0"
      on "context record" as Input "issue"
      and materializes "description" from field "summary"
      and must establish "the recorded description is available"
      """js
      fact.summary !== "" || fail("the context description is empty")
      """
```

`returned` exposes an observed role. It cannot expose a root input, a fixed value
or an agent declaration. This example establishes availability, not approval.

## 2A. Known work: invoke the published child

After authorized publication of the child, this complete parent can compile:

```gherkin procedure
@trust-dsl:1 @procedure:known-usage-context @version:1.0.0
Feature: Delegate one known context observation
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the assigned context record. | Edit it or approve product decisions. |
    And one reference "context record"
    And one string "observed description"
  @scenario:context
  Scenario: Recover the child description
    Then Invocation "observe context" runs Procedure "observe-usage-context@1.0.0"
      on "context record" as Input "context record"
      and materializes "observed description" from Result "description"
      and must establish "the context observation is complete"
```

Engagement root inputs: `{"context record":"EXPORT-42"}`. Read the parent to get
the created child's identifier. Static composition is pinned at engagement.

## 2B. Unknown work: reserve space, then append a mission

This complete parent reserves unknown contexts before engagement:

```gherkin procedure
@trust-dsl:1 @procedure:discover-usage-contexts @version:1.0.0
Feature: Clarify contexts discovered while describing a feature
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read contexts of the assigned feature. | Edit records or change the feature scope. |
    And one reference "feature"
    And missions "context-work" declared by agent
    And many string "context descriptions"
  @scenario:contexts
  Scenario: Complete the declared investigations
    Then Invocation "clarify contexts" runs each declared Procedure in "context-work"
      and materializes "context descriptions" from Result "description"
      and must establish "the declared context investigations are complete"
```

Engagement root inputs: `{"feature":"EXPORT-10"}`. No invented empty description
or extra root input. An empty mission collection waits for work; it is not a
successful no-op. Use a lowercase slug such as `context-work` for its name.

Read the parent. Assemble these arguments for `trust_plan_declarations_replace`;
variables refer to values you have just read or complete sources shown above:

```javascript
const mission = {
  id: "automated-consumer",
  rootInputs: { "context record": "EXPORT-42" },
  definition: {
    kind: "inline",
    procedureSource: childSource,
    operationSources: [], // jira.issue-read@1.1.0 is already installed
  },
};
const argumentsForDeclarations = {
  plan: parentPlanId,
  expectedRevision: currentRevision,
  declarations: currentDeclarations,
  missionDeclarations: {
    "context-work": [...acceptedMissions, mission],
  },
};
```

For this first mission, `currentDeclarations` is `{}` and `acceptedMissions` is
`[]`. The static and inline routes are alternatives: if you already published
`observe-usage-context@1.0.0` in step 2A, use the published definition below or
give a genuinely new inline draft an unused identity. An inline Procedure cannot
conflict with a published identity, even with identical text.

On subsequent additions, preserve every accepted mission's id, definition
and rootInputs unchanged; carry forward other collections too. A changed
accepted mission is refused. Identical resubmission reuses its child.
Omit `missionDeclarations` when only replacing scalar declarations.

To remove an accepted mission that was never executed, submit its collection
without it. TRUST accepts the removal only when no generation of its child Plan
(or of a descendant) ever admitted an Attempt; otherwise the whole replacement is
refused with `Accepted mission "<id>" cannot be removed: its child Plan admitted
an Attempt`. After the removal the parent no longer counts that child: its
generation is superseded and stays readable. The earlier parent revision in
`plan.read` `revisions` still lists the removed mission. Remove a mission only on
an explicit decision, for example a contract that can never run.

When a Corpus thread drives the work, an approved requirement is never edited:
a later decision withdraws its criteria with a top-level block in the thread
document, `::::withdrawal{#TRUST-FR-CXP-180 criteria=AC1,AC2}`, then the reason,
then `::::` (without `criteria`, the whole requirement). Once an approved revision
holds it, coverage no longer requires those criteria. The Corpus extension
README describes the refusals and the thread read.

To use an installed child instead, change only its definition:

```json
{ "kind": "published", "reference": "observe-usage-context@1.0.0" }
```

To use the custom HTTP read from the [external I/O example](external-io.md), adapt
the child **before acceptance** and supply the complete Operation source:

```javascript
const customChildSource = childSource
  .replace("jira.issue-read@1.1.0", "method.context-read@1.0.0")
  .replace('as Input "issue"', 'as Input "record"')
  .replace('from field "summary"', 'from field "description"')
  .replace('fact.summary !== ""', 'fact.description !== ""');
const customDefinition = {
  kind: "inline",
  procedureSource: customChildSource,
  operationSources: [readOperationSource],
};
```

Use that definition for a new mission; do not rewrite an accepted one. Omit an
inline Operation source if its exact identity is already installed. Both inline
Procedure and Operation identities must be free of catalog conflicts. Acceptance
validates and pins the complete inline composition before creating the child.
It does not publish these sources into the reusable catalog.

## 3. Dispatch, execute, collect

| Step | Concrete action | Observable result |
| --- | --- | --- |
| Accept work | Submit the mission, then read the parent | Invocation identifies the actual child Plan |
| Hand off, when authorized | Give the worker the child Plan identifier, purpose, assigned scope and expected Result | Worker reads that child, not an invented Plan |
| Execute | Worker follows the [execution card](run-plan.md) and Runner | TRUST reports Check qualification |
| Collect | Coordinator reads the parent again | A fully validated child supplies `description` to `context descriptions` |
| Continue | Read the parent's newly available Checks or remaining children | Parent work follows its own dependencies |

Example handoff contents: child Plan from the Invocation; purpose “observe
EXPORT-42's description”; allowed read only; forbidden editing or approving;
expected observed Result `description`; report the actual TRUST outcome and any
blocker. Host messaging transports the assignment, not the Result qualification.

Native child Plans already retain the mission inputs, agent declarations and qualified Results. Do not mirror them into an external mission registry.

## 4. Enrich the method without rewriting its history

| Discovery | Do this |
| --- | --- |
| Another context within the reserved work | Append a new mission with its own inputs and sources |
| Need an additional external observation | Put an inline Operation and its qualifying Check in the new child |
| Existing parent has no suitable mission collection | Keep its engaged definition intact; revise the draft/new version and arrange a separately authorized Plan |
| Same pattern is useful on another feature | Review the retained inline sources, observations and Results; consolidate a reusable Procedure/Operation version when authorized |

Parent root inputs, fixed roles and engaged definitions remain immutable. Results
enrich observed roles. If a child loses validation, its imported Results are
withdrawn and dependent work reopens: reread the Plan instead of trusting an old
worker report.

A mission collection's Result target is an **unscoped `many` role**. This example
therefore returns descriptions, not a parent-scoped map of descriptions to
features. For correlation, read each Invocation/child identity and inputs, use
static scoped composition, or return references to structured external records.
Do not zip independent returned arrays by position.

Details: [Procedure grammar](../../../packages/trust-ui/src/docs/content/en/language/procedures.mdx),
[execution and coordination](../execute-and-coordinate.md),
[verification](../verify-and-test.md).
