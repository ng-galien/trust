# I want an external answer to gate the next stage

An external gate is an **ordinary TRUST Check**: its Operation reads data from
another system, and TRUST qualifies that data. A validated Check permits dependent
work through the Procedure's normal prerequisites. There is no separate
confirmation mechanism in the engine.

```text
External form: user answers yes/no
    → Operation reads the answer
    → Check qualifies it
    → dependent development becomes actionable, or stays blocked
```

Agent declarations still supply the roles the Procedure assigns to the agent.
When the method requires an external answer, a declaration cannot substitute for
that observation. The method chooses the source and the criterion.

## 1. Define the external input

Example method: the user confirms the feature refinement in an external form.
Assume `GET /confirmations/<feature>?revision=<revision>` returns:

```json
{ "feature": "CSV-42", "revision": "r3", "answer": "yes" }
```

`answer` is `yes`, `no` or `pending`. This is an illustrative form-adapter contract,
not an existing Maket or Jira endpoint. For a design exercise, state this
assumption and continue; implementing the connector is a separate step.

This example relates the answer to the submitted feature revision. That is a
choice of this method, not a new universal TRUST approval policy. The external
system owns how the user enters and confirms the answer.

## 2. Read the answer through an Operation

```gherkin operation
@trust-dsl:1 @operation:method.confirmation-read @version:1.0.0
Feature: Read the external answer for a feature refinement
  Background: Operation interface
    Given Environment
      | name | type |
      | confirmationsUrl | url |
    And Input
      | input | type | cardinality |
      | feature | reference | one |
      | revision | reference | one |
    And Produced fields
      | field | type | cardinality | domain |
      | feature | reference | one | any |
      | revision | reference | one | any |
      | answer | string | one | enum "yes", "no", "pending" |
  Scenario: Run
    When HTTP "confirmation" sends "GET" to Environment "confirmationsUrl"
      appending Input "feature" with query "revision" from Input "revision" and reads JSON
    Then Produce with JSONata
      """
      {
        "feature": steps.confirmation.body.feature,
        "revision": steps.confirmation.body.revision,
        "answer": steps.confirmation.body.answer
      }
      """
```

If the form instead returns a JSON boolean at `approval.allowDevelopment`, with
identity under `refinement.id` / `refinement.revision`, replace the projection with
the following. Produced has no boolean type: keep the `answer` string enum and
convert explicitly. The assertion rejects missing, null or string `"true"` values.

```jsonata
{
  "feature": steps.confirmation.body.refinement.id,
  "revision": steps.confirmation.body.refinement.revision,
  "answer": (
    $assert($type(steps.confirmation.body.approval.allowDevelopment) = "boolean", "allowDevelopment must be a JSON boolean");
    steps.confirmation.body.approval.allowDevelopment = true ? "yes" : "no"
  )
}
```

Details: [supported projection functions](../../../packages/trust-ui/src/docs/content/en/operations/produce.mdx).

## 3. Qualify it with a normal Check

This complete Procedure requires the Operation above. It can be a child of the
refinement workflow. Its roots are
`{"feature":"CSV-42","refinement revision":"r3"}`.

```gherkin procedure
@trust-dsl:1 @procedure:confirm-feature-revision @version:1.0.0
Feature: Gate development on the external refinement answer
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the external refinement answer. | Supply the user's answer on their behalf. |
    And one reference "feature"
    And one reference "refinement revision"
    And one reference "confirmed revision" returned
  @scenario:confirmation
  Scenario: Qualify the external answer
    Then Check "refinement gate" runs Operation "method.confirmation-read@1.0.0"
      on "feature" as Input "feature"
      using "refinement revision" as Input "revision"
      and materializes "confirmed revision" from field "revision"
      and must establish "the external answer allows development of this refinement"
      """js
      (fact.feature === context["feature"] &&
       fact.revision === context["refinement revision"] && fact.answer === "yes") ||
      fail("the external answer does not allow this refinement to proceed")
      """
```

## 4. Make the next stage depend on the gate

The parent invokes that Procedure and materializes its `confirmed revision`
Result using the [delegation pattern](delegation.md). After a parent Scenario
named `confirmation` has recovered that role, development can follow this
**fragment**:

```gherkin fragment
  @scenario:development
  Scenario: Develop the confirmed perimeters
    Given scenario "confirmation" is validated
    Then Invocation "develop perimeter" runs Procedure "project-develop-perimeter@1.0.0"
      on each "perimeter" as Input "perimeter"
      using "feature" as Input "feature"
      using "confirmed revision" as Input "revision"
      and must establish "the perimeter satisfies its confirmed requirements"
```

`project-develop-perimeter` is the project's child method, not a built-in
Procedure. Alternatively, place the gate Check directly in the parent; the next
Scenario uses the same prerequisite rule. Host dispatch remains separate.

| External observation | Check outcome | Consequence |
| --- | --- | --- |
| `yes` for the assigned feature/revision | `VALIDATED` | Dependent work may proceed |
| `no` or `pending` | `NOT_VALIDATED` | Gate remains `OPEN`; dependent work stays blocked |
| `yes` for another feature/revision | `NOT_VALIDATED` under this example's criterion | Wrong answer cannot release this work |
| Failed read or incomplete Produced values | No accepted Facts, no new qualification | Report/recover the read; never invent an answer |

When the external answer changes, read current Plan state and use the Runner's
supplied URI to retry the open Check. A submitted form or HTTP 200 is only an
external action result; the Check's authored qualification determines progress.

TRUST does not automatically watch arbitrary external systems. If later changes
must be detected, the method needs a further observation at the relevant stage.
A final review can use exactly the same pattern: observe the external review
result, qualify it against the chosen candidate and criteria, then continue or
remain blocked. For richer provenance, add actor or content-version fields to the
Operation and qualification when that project's method calls for them.
