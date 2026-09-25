# I want to refine a feature, delegate development and review it

Combine the recipes; choose the criteria for this project's method. The form
system supplies structured inputs and results. TRUST qualifies Checks and their
dependencies; the host assigns work to people or agents.

## 1. Keep a small, connected feature model

Example external form state, editable through the chosen system:

```json
{
  "feature": "CSV-42",
  "revision": "r3",
  "description": "Export the filtered records with visible progress and existing access rights",
  "requirements": [
    { "id": "filters", "text": "Respect the current filters" },
    { "id": "progress", "text": "Show export progress" },
    { "id": "rights", "text": "Enforce existing caller rights" }
  ],
  "perimeters": [
    { "id": "backend", "requirements": ["filters", "progress", "rights"] },
    { "id": "frontend", "requirements": ["filters", "progress", "rights"] }
  ],
  "questions": [{ "id": "filter-snapshot", "answer": null }],
  "confirmation": { "revision": "r3", "answer": "pending" }
}
```

This is an example adapter's document, not a required Maket schema. The refinement
clarifies unanswered scope and acceptance criteria. Do not turn “a description
exists” into “the feature is ready”; choose the observations and criteria needed
by the actual method. A missing connector can be an explicit design assumption.

## 2. Assign each stage its data and criterion

| Stage | Concrete work | What the Check qualifies |
| --- | --- | --- |
| Refine | Agent/person fills description, scopes, requirements, acceptance cases and unresolved questions | The method's chosen readiness criteria over the observed document |
| Gate | User answers in the external system | Its observed yes/no answer through an [ordinary Check](human-confirmation.md) |
| Develop | Host assigns backend and frontend child Plans | Each child qualifies the result against its assigned revision and acceptance criteria |
| Review | Reviewer examines the combined candidate and records findings/results | Review observations concern the current child results and meet the final criteria |

## 3. Bind the known perimeters explicitly

Parent context **fragment**; producing steps supply the two observed roles:

```gherkin fragment
    And one reference "feature"
    And many reference "perimeter" for "feature"
    And one reference "confirmed revision" for "feature"
    And many reference "delivery" for each "perimeter"
    And one reference "review record" declared optionally by agent
```

Root inputs for this shared-parent shape:

```json
{ "feature": "CSV-42", "perimeter": ["backend", "frontend"] }
```

The single shared feature makes `perimeter` a plain root array. In contrast,
agent-declared values `for each` of several features need explicit `{value,
parents}` coordinates as shown in [related context](related-context.md).

After the parent Scenario `refinement` has qualified the external answer and
materialized `confirmed revision`, this **fragment** delegates the known work:

```gherkin fragment
  @scenario:development
  Scenario: Develop each confirmed perimeter
    Given scenario "refinement" is validated
    Then Invocation "develop perimeter" runs Procedure "project-develop-perimeter@1.0.0"
      on each "perimeter" as Input "perimeter"
      using "feature" as Input "feature"
      using "confirmed revision" as Input "revision"
      and materializes "delivery" from Result "delivery"
      and must establish "each perimeter meets its confirmed acceptance criteria"
```

The project-specific child takes exactly `feature`, `revision`, `perimeter` as
roots. It reads the corresponding scope/requirements, performs the assigned work
and qualifies its result. Its `delivery` is an observed `returned` reference to a
structured result containing the feature, revision, perimeter, candidate and test
report references. A worker's message alone does not return that Result.

Known backend/frontend work needs no dynamic mission collection merely to launch
two agents. Reserve [missions](delegation.md) for investigations or work that the
method expects to discover progressively; preserve accepted missions unchanged.

## 4. Review the combined result

Assume a project Operation `project.review-read@1.0.0` reads a selected review and
produces `feature`, `revision`, `deliveries`, `candidate`, `testedCandidate` and
`decision`. This **fragment** illustrates the parent's final Check:

```gherkin fragment
  @scenario:review
  Scenario: Review the current combined candidate
    Given scenario "development" is validated
    Then Check "final review" runs Operation "project.review-read@1.0.0"
      on "review record" as Input "review"
      and must establish "review accepts the current combined result"
      """js
      (fact.feature === context["feature"] && fact.revision === context["confirmed revision"] &&
       fact.deliveries.length === context["delivery"].length &&
       context["delivery"].every(delivery => fact.deliveries.includes(delivery)) &&
       fact.candidate !== "" && fact.candidate === fact.testedCandidate &&
       fact.decision === "accepted") || fail("review does not accept the current candidate and deliveries")
      """
```

Define what `accepted` means in the external review contract and authored method.
For example, the actual required acceptance cases ran against `testedCandidate`
and no blocking finding remains. An agent-editable “passed” field is only a
statement unless the data source establishes the verification it represents.
Do not invent a native review endpoint: draft the adapter's Operation with the
[external I/O pattern](external-io.md).

## 5. Handle a finding and consolidate the method

| Change | Next action |
| --- | --- |
| Form answer is still no/pending | Keep the external gate open; resume its Check when the answer changes |
| A review finds a defect in one perimeter | Correct within scope, create a new result reference, and replace the child role declared to select that result; verify the changed Check input again |
| Child result changes | Read parent state; previous imported Result/qualification can be withdrawn and dependent review reopened |
| Feature scope itself changes | Do not overwrite immutable roots or child inputs; use the method's reserved work or an authorized new version/Plan for the changed scope |
| An investigation reveals a repeatable step | Keep the inline sources and history; consolidate into the reusable method when authorized |

A revised result reference can reopen a live Check because its declared Input
changed. This is not a generic command to re-observe an unchanged satisfied live
Check. The method also needs explicit observations wherever it must detect changes
in the external form; TRUST does not automatically watch that system.

These fragments illustrate composition, not a complete deployable method. Use
the complete [delegation examples](delegation.md) for syntax, the project's actual
Operation contracts for observations, and [rehearsal](rehearse-procedure.md) for
verification when needed.
