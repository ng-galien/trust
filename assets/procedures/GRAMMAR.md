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
  [using [all] "<role>" as Input "<input>" ...]
  [and materializes "<role>" from field "<field>" ...]
  and must establish "<success reason>"
```

`on` identifies the Check target and binds one Operation Input. `using` binds every remaining
Input. Every required Input is bound exactly once. `each` creates one Check per role value; `all`
passes one collection. The compiler validates types, cardinalities and parent scope against the
compiled Operation.

A materialization names both its Plan role and its Operation field. There is no implicit output,
binding or registry lookup.

Every Check has this exact table:

```gherkin
| field       | relation | expectation   | failure reason             |
| workingTree | equals   | value "clean" | "the repository is not clean" |
```

Relations are `equals`, `at least`, `has at least`, `is in`, `before` and `after`.
Expectations are:

```text
value "clean"
number 1
valid rfc3339
context "fix revision"
field "builtRevision" from Check "Docker image"
```

An upstream Check field or a materialized context value must come from a prerequisite Scenario.
Types and cardinalities must match.

Every Scenario ends exactly with:

```gherkin
And the Scenario is satisfied when every Check is validated
```

## Compiled revision

The compiler emits `trust.compiled-procedure@3` with roles, Scenarios, Checks, deterministic
digests and the exact `CompiledOperation` definitions used by the Procedure. Source formatting,
comments and JSONata formatting do not change an Operation digest; a semantic Operation change
does.
