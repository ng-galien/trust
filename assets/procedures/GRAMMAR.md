# TRUST Procedure grammar

This document defines the closed Procedure language compiled by `@trust/procedure`.

## Feature

```gherkin
# language: en
@trust-dsl:1 @procedure:git-status @version:2.0.0
Feature: Establish whether a Git repository has local changes
```

The Feature has exactly these three tags. Procedure and Scenario identifiers are lowercase slugs;
the version is semantic.

## Plan context

Every Procedure has one `Background: Plan context`. Each line declares one typed role:

```gherkin
Given one reference "jira issue"
And many reference "affected project" declared by agent for "jira issue"
And many reference "fix revision" for each "affected project"
And one reference "acceptance project" fixed as "payment-acceptance"
```

The closed types are `string`, `number`, `instant` and `reference`. Cardinality is `one` or `many`.
A fixed value is limited to one `string` or one `reference`. A role is one of:

- a Plan input when no other source is declared;
- an agent declaration;
- a fixed value;
- a field materialized by one Check.

`for` and `for each` declare parent scope. Parent graphs are acyclic. The parent relation preserves
which value belongs to which parent. It lets an `on each` Check select related values without
depending on array position.

## Scenario dependencies

A Scenario has one `@scenario:<slug>` tag. Dependencies precede Checks:

```gherkin
Given scenario "baseline" is validated
And scenario "red" is validated
```

Dependencies must reference existing Scenarios and form an acyclic graph.

## Check

The complete Check sentence is:

```text
Check "<name>" runs Operation "<domain.action>"
  on [each|all] "<role>" as Input "<input>"
  [using [all] "<role>" as Input "<input>" | using plan as Input "<input>" ...]
  [and materializes "<role>" from field "<field>" ...]
  and must establish "<success reason>"
```

`on` identifies the Check target and binds one Operation Input. `using` binds every remaining
Input. Every required Input is bound exactly once. `using plan as Input "<input>"` binds the Plan
identifier given at engagement to one `string` or `reference` Input of cardinality `one`; `plan` is
a reserved role name that no Background may declare: the binding compiles to a synthesised role
`"plan"` with source `plan-identifier` (one string, seeded with the Plan slug at engagement) and an
ordinary `{ input, role: "plan", selection: "one" }` binding; its value never changes, so it never
reopens the Check. `each` creates one Check per role value; `all`
passes one collection. The compiler validates types, cardinalities and parent scope against the
compiled Operation.

A materialization names both its Plan role and its Operation field. There is no implicit output,
binding or registry lookup.

Every Check has exactly one `js` DocString attached to its Check step:

```gherkin
"""js
fact.workingTree === "clean" ||
fail(`The working tree is ${fact.workingTree}`)
"""
```

One guard is `booleanExpression || fail(stringExpression)`. Independent guards join with `&&` and
retain source order. The expression sees only:

- `fact.<field>` for the current Check's Produced values;
- `context.<role>` or `context["natural role name"]` for visible Plan roles;
- `checks.<check>.<field>` or bracket access for Produced values of prerequisite Checks.

The compiler accepts a closed expression surface: finite literals and homogeneous arrays; strict
comparisons; arithmetic; boolean and ternary operators; template strings; the documented `Math`,
array and string methods. It rejects assignments, statements, mutation, arbitrary calls, host APIs
and dynamic properties. JSEP parses the expression, TRUST resolves and statically types it, and the
compiler emits canonical JSON Logic guards. JavaScript source is never executed.

An upstream Check field or a materialized context value must come from a prerequisite Scenario.
Names, types and cardinalities must match. Every Scenario contains at least one Check; its
satisfaction follows from the state of those Checks and requires no closing step.

## Compiled revision

The compiler emits the current Procedure structure with roles, Scenarios, Checks, deterministic
digests and the exact `CompiledOperation` definitions used by the Procedure. Source formatting,
comments and JSONata formatting do not change an Operation digest; a semantic Operation change
does.
