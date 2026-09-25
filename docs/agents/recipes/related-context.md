# I want to model a feature and its related usages

Use this when several values belong to different parents. Example method: each
feature has usage records in Jira; this example method stores the **short usage
description in Jira's `summary` field** and requires it to be nonempty. This is
an explicit example convention, not an equivalence between Jira summary and its
separate description field. It checks availability, not approval or completeness.

## 1. Start with the relationship

```text
EXPORT-10 (feature)
  ├─ EXPORT-11 (usage) → "Download from the browser"
  └─ EXPORT-12 (usage) → "Fetch from an automated client"
IMPORT-20 (feature)
  └─ IMPORT-21 (usage) → "Upload from the browser"
```

| Value | Role source | Why |
| --- | --- | --- |
| Feature identifiers | Root input | The assignment fixes the scope |
| Usage identifiers and their feature | Agent declaration | Investigation identifies these later |
| Description of each usage | Observed field | Read it from the record rather than declare it true |

## 2. Adapt this complete Procedure

Requires installed `jira.issue-read@1.1.0`; inspect its interface before adapting.
If the assignment requires the actual Jira description or another structured
field, this Operation is insufficient: author a projection for that field's real
API shape using the [external I/O recipe](external-io.md). Do not substitute a
nonempty title for a requested description.

```gherkin procedure
@trust-dsl:1 @procedure:describe-feature-usages @version:1.0.0
Feature: Establish a description for each declared feature usage
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the assigned feature usage records. | Edit records or approve the feature. |
    And many reference "feature"
    And many reference "usage" declared by agent for each "feature"
    And one string "usage description" for each "usage"
  @scenario:descriptions
  Scenario: Observe each usage description
    Then Check "read usage" runs Operation "jira.issue-read@1.1.0"
      on each "usage" as Input "issue"
      and materializes "usage description" from field "summary"
      and must establish "the usage has a recorded description"
      """js
      fact.summary !== "" || fail("the usage description is empty")
      """
```

The Scenario tag is the stable dependency name. The scope table describes the
allowed work. `on each` creates a Check per usage; `for each` retains its parent
relation. There is no positional zip between unrelated arrays.

## 3. Supply roots, then declarations

Compile with `trust_procedure_compile({source})`. For authorized publication use
`trust_procedure_publish({source, sourceName})`. Then, if engagement is assigned,
these are arguments to `trust_plan_engage` (choose your actual Plan and Environment):

```json
{
  "procedure": "describe-feature-usages",
  "procedureVersion": "1.0.0",
  "plan": "feature-usages-example",
  "environment": "local",
  "rootInputs": { "feature": ["EXPORT-10", "IMPORT-20"] }
}
```

Read `trust_plan_read({plan:"feature-usages-example"})`. At revision 1, the
following is a complete `trust_plan_declarations_replace` payload for this example:

```json
{
  "plan": "feature-usages-example",
  "expectedRevision": 1,
  "declarations": {
    "usage": [
      { "value": "EXPORT-11", "parents": [{ "role": "feature", "value": "EXPORT-10" }] },
      { "value": "EXPORT-12", "parents": [{ "role": "feature", "value": "EXPORT-10" }] },
      { "value": "IMPORT-21", "parents": [{ "role": "feature", "value": "IMPORT-20" }] }
    ]
  }
}
```

Replace `expectedRevision` with the value just read. `declarations` is the complete
snapshot of agent-declared roles, not a patch. Include other current declarations
when adapting. Never put the observed descriptions into that map.

Expected Check Input values after declaration:

| Feature scope | Usage scope | Operation Input |
| --- | --- | --- |
| EXPORT-10 | EXPORT-11 | `{"issue":"EXPORT-11"}` |
| EXPORT-10 | EXPORT-12 | `{"issue":"EXPORT-12"}` |
| IMPORT-20 | IMPORT-21 | `{"issue":"IMPORT-21"}` |

Run each supplied URI through the Runner. Only a `VALIDATED` Check materializes
its description. Jira produces its full interface (`issue`, `summary`,
`issueType`, `workflowStatus`), even though this qualification uses only `summary`.

## 4. Choose the variation you actually need

| Need | Change |
| --- | --- |
| One shared parent | Use `for "feature"` with a single feature |
| One choice for every parent | Use `one … declared by agent for each …`; still send `{value, parents}` entries |
| Discovery is optional | Use `declared optionally by agent`; do not add required root descendants below it |
| Read a revision, then use the right revision for each repository | Materialize a role `for each "repository"`; a later Check `on each "repository" using "revision"` selects the matching value |
| Preserve a rich editable JSON document | Keep a reference to it; project the needed nested fields with an [Operation](external-io.md) |
| Discover a new kind of work | Declare a [mission](delegation.md), not an undeclared context key |

TRUST role types are `string`, `number`, `instant`, `reference`, with `one` or
`many` cardinality. Relationships use parents; arbitrary nested objects are not
a fifth role type. Do not serialize the whole model into a string to avoid modeling
the relationships that Checks need.

Details: [context grammar](../../../packages/trust-ui/src/docs/content/en/procedures/context.mdx),
[Check binding](../../../packages/trust-ui/src/docs/content/en/procedures/scenarios-and-checks.mdx),
[Jira Operation source](../../../assets/operations/jira.issue-read.feature).
