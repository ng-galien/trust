# TRUST autonomous Feature grammar

This file defines the closed product language compiled by TRUST. One English `.feature` source is
the complete business input to compilation and publication. The server has no procedure-specific
rule, Action Contract catalog, suite catalog or Skill-to-capability map.

## Source envelope and language version

Every source starts with the exact language and Feature tags:

```gherkin
# language: en
@trust-dsl:1 @procedure:defect-correction @version:3.0.0
Feature: Fix a Jira defect and deploy the committed fix on Kubernetes
```

`@trust-dsl:1` is mandatory and selects the grammar described here. A missing tag or any other DSL
version is rejected. `@procedure` is a canonical lowercase slug and `@version` is a semantic
version. These are the only Feature tags. The source contains exactly one `Background: Procedure
interface`; every Scenario has exactly one canonical `@scenario:<slug>` tag.

The Feature owns three semantic layers:

1. Skill capability declarations define stable typed inputs, authentic observations and output
   projections;
2. named Checks bind procedure roles to capability ports, materialize new roles and define typed
   qualification predicates with business feedback;
3. scenario prerequisites and Check-observation references form the complete Plan dependency graph.

Compilation emits one `actionContractDigest` per exact capability contract, one
`compiledCheckDigest` per Check template and one `definitionDigest` for the complete procedure.
A `definitionDigest` identifies the canonical compiled semantics: comments and table alignment do
not change it. The exact source remains an immutable publication artifact, so an editor can reopen
what was authored without making presentation choices part of runtime identity.
A Skill release claims only `(capability, actionContractDigest)`. It never defines the contract,
the Check or the qualification.

## Procedure interface

The Background contains capability declarations and the procedure roles.
Declaration order is editorial.

```gherkin
Given Skill capability "git.head-compare" performs read and is replayable
And Skill capability "git.head-compare" accepts
  | input         | type      | cardinality |
  | repository    | reference | one         |
  | base revision | reference | one         |
And Skill capability "git.head-compare" reports
  | observation           | type      | cardinality | domain                |
  | head revision          | reference | one         | any                   |
  | compared base revision | reference | one         | any                   |
  | commits ahead          | number    | one         | any                   |
  | working tree           | string    | one         | enum "clean", "dirty" |
And Skill capability "git.head-compare" exposes outputs
  | output        | from observation | parents            |
  | head revision | head revision     | input "repository" |
```

The closed value types are `string`, `number`, `reference` and `instant`. Cardinality is `one`,
`many`, or `one for each input|observation "port"`. A correlated value is an unordered
collection of `{value, parents[]}` coordinates; positional zipping has no meaning.

Effects are `read`, `create`, `update`, `delete`, `publish`, `transition`, `send` and `deploy`.
Replay policy is `replayable` or `human-intervention`. Replayability permits another invocation
after missing Facts; it does not create a generic retry engine.

An observation domain is `any` or an exhaustive enum. Every observation required by the current
Check predicates, a Check-observation consumer or an output must be present in one accepted Fact
batch. An output projects exactly one authentic observation and carries its declared parent
coordinates. The Skill emits capability ports; TRUST maps them to procedure roles.

The word `reports` above declares observation ports. It does not create an intermediate product
resource or an alias that a later Check can query.

## Procedure roles

Roles use the closed forms:

```gherkin
And one "jira issue"
And many "affected project" declared by agent for "jira issue"
And many "acceptance criterion" declared by agent for "acceptance project"
And one "planned modification" declared by agent for each "affected project"
And one "fix commit" for each "affected project"
And one "acceptance project" fixed as "payment-acceptance"
```

A non-fixed role with no provider and no `declared by agent` marker is an immutable root Plan input.
A fixed role is procedure policy. A `declared by agent` role belongs to the Plan's current declaration
snapshot: the agent replaces that snapshot through MCP, and TRUST validates its names, types,
cardinalities and parent coordinates against the Feature before creating a revision. A role
materialized by a satisfied Check is provider-owned. Role parent graphs are typed and acyclic. A
Skill can materialize only its declared outputs; it can never write an agent-declared role.

An agent declaration is exact product data. It may use ordinary human-readable wording, including
spaces and punctuation. When a declared value becomes an `on each` Check target, TRUST derives the
URI-safe segment internally while preserving the exact value in the Plan, the Check target and the
Skill input. Neither the Feature author nor the agent encodes a declaration for a Check URI.

## Named Checks and Skill capabilities

A Scenario contains one or more named Checks. The first uses `Then`; additional Checks in the same
Scenario use `And`.

```gherkin
Then Check "fix comparison" uses Skill capability "git.head-compare" on each "affected project" as input "repository" using "code baseline commit" as input "base revision" and materializes "fix commit" from output "head revision" and must establish "every fix is committed after its code baseline"
  | observation            | relation | expectation                    | failure feedback                                  |
  | compared base revision | equals   | context "code baseline commit" | "a fix has another code baseline"                |
  | commits ahead          | at least | number 1                       | "a fix is not committed"                         |
  | working tree           | equals   | literal "clean"                | "an affected repository has uncommitted changes" |
```

The closed Check sentence is:

```text
Check "<name>" uses Skill capability "<domain.action>"
  on [each|all] "<role>" as input "<port>"
  [using [all] "<role>" as input "<port>" ...]
  [and materializes "<role>" from output "<port>" ...]
  and must establish "<success feedback>"
```

Check names are canonical and unique within the Feature. `on`, `on each` and `on all` select one
role value, one independently addressable Check per member, or the complete collection. `using`
and `using all` bind the remaining capability input ports with the same parent-scope checks. The
Skill receives a map keyed by capability input ports, never by procedure role names.

Every materialization names both the procedure role and the capability output port. There is no
implicit target, binding, output source, intermediate alias or aggregation reducer.

## Qualification expressions

The qualification table always has exactly these columns:

```text
observation | relation | expectation | failure feedback
```

The closed relations and shapes are:

- `equals`: equal typed scalars, unordered collections or correlated graphs; collection order is
  irrelevant and duplicate multiplicity is significant;
- `at least`: one number against one number;
- `has at least`: collection cardinality against one number;
- `is in`: one uncorrelated typed value in an uncorrelated collection of the same type;
- `before` and `after`: one instant against one instant.

The only qualification expectation forms are:

```gherkin
literal "clean"
number 1
valid rfc3339
context "fix commit"
observation "built revision" from Check "docker build"
```

`literal` is a string and must belong to the declared enum when the observation has an enum domain.
`number` is explicit numeric syntax. `valid rfc3339` is valid only for one instant with `equals`.
`context` must name a role bound by the current Check. `observation ... from Check ...` must name an
observation reported by one uniquely named Check in a transitively prerequisite Scenario. It pins
the exact active provider qualification; no free-text name resolution is performed.

Every failed predicate returns its authored `failure feedback`. `actionOutcome` is never an input
to qualification.

## Dependencies, Check state and resumption

The complete dependency language has two forms.

First, a Scenario lists prerequisite Scenarios before its Checks:

```gherkin
Given scenario "defect-reproduction" is validated
And scenario "code-baselines" is validated
```

Second, a qualification expectation consumes an observation from a named upstream Check:

```gherkin
observation "built revision" from Check "docker build"
```

The observation reference is both typed data flow and a dependency on that provider Check. There
is no third dependency form. In particular, a Check cannot declare a free-standing predecessor.
Delegation is refused before the external action until every prerequisite Scenario is validated
and every Check referenced by an observation has an active `VALIDATED` qualification.

Every Scenario ends with the exact aggregation sentence:

```gherkin
And the scenario is verified when all Skill actions are validated
```

A Check has only the public state `OPEN` or `SATISFIED`. `VALIDATED` and `NOT_VALIDATED` are
qualification verdicts for an accepted attempt, not additional Check states. New accepted Facts for
one Check replace its active qualification and recursively make every dependent Check `OPEN` across
both dependency forms. Independent Checks keep their current qualification. The same Plan resumes
from any open Check whose dependencies are satisfied.

Facts and Snapshots remain immutable history. New `VALIDATED` Facts from a provider authoritatively
replace the current projection of every collection role it owns. When that projection omits a
previous member, an instantiated `on each` Check whose semantic target is that role incarnation is
absent from the new Plan revision; its historical Facts, Snapshots and attempts are not erased. If
the member is projected again, the same semantic Check URI is rematerialized with its history and a
new activation context.

A `NOT_VALIDATED` qualification does not authoritatively remove a projected member. Previously
instantiated Checks remain visible and become `OPEN` through normal dependency invalidation. A
refusal, missing-Facts rejection, crash or transport interruption produces no qualification or Plan
revision, so current collection membership and Check state remain unchanged.

## Publication and runtime

`procedure.definition.compile` and `procedure.definition.publish` accept only `{source,
sourceName}`. Publication persists the source, compiled definition, exact capability requirements
atomically and immutably under `procedure@version`. A running server can
immediately engage the published procedure; no restart or generated configuration is required.

Plan engagement supplies only procedure/version, Plan identifier, environment and the closed root
inputs. After engagement, `trust_plan_declarations_replace` atomically replaces the complete current
snapshot of only the roles marked `declared by agent`, using an expected revision. Additions,
removals and replacements create immutable Plan revisions; removed Checks leave the current view but
remain in history. This is not a generic context patch and cannot address fixed, root-input or
Skill-produced roles. Plan engagement does not require a Skill to exist. At attempt time TRUST exact-matches the compiled
capability requirement to a Skill claim. In `verified` policy it also requires authorization,
selection and a live announcement before any external action.

The compiler rejects unknown steps, tags, columns, ports, roles, relations, expressions, cycles,
cardinality mismatches, URI collisions and ignored DataTables or DocStrings. It executes no plugin,
step definition, import, code or SQL from the Feature.
