# Procedure composition

Status: proposal with unresolved product decisions.

This evolution makes a Procedure usable as a Requirement inside another Procedure. A composed
Procedure occupies the same structural position as a Check, but it is never sent to the Runner. Its
leaf Checks remain the only executable units.

The proposed surface is small and follows the current Check sentence closely. The technical impact
is not limited to parsing: composition introduces reusable interfaces, recursively embedded
definitions, runtime instances and namespaced identity inside one root Plan.

## Confirmed product boundary

A Scenario contains Requirements. A Requirement is one of:

```text
Check       -> delegates one embedded Operation
Procedure   -> expands one embedded Procedure
Repeat      -> expands successive iterations of one embedded Procedure
```

`Repeat` is defined separately in `repeated-procedures.md`.

The distinction remains:

- a Check is qualified by TRUST from accepted Facts;
- a Procedure Requirement is satisfied only from the satisfaction of its child Procedure instances;
- the Runner receives exactly one semantic Check URI and one compiled Operation;
- an agent never declares that a Procedure, Requirement, Scenario or Plan advanced;
- composition creates no second qualification engine.

## Current executable baseline

The current compiler and runtime are flat:

- `ProcedureCompilationInput` receives compiled Operations only;
- `CompiledProcedure` contains global arrays of roles, Scenarios and Checks;
- Check names and Scenario slugs are unique inside the Procedure;
- `buildPlanRevision` iterates one static `procedure.checks` array;
- runtime role values use a role name and one provider Check URI;
- runtime Check values use a Check name and one provider Check URI;
- Scenario dependencies are stored as unqualified Scenario slugs;
- actionability treats every Check of a prerequisite Scenario as required;
- Plan completion currently means that no Check remains open and no declaration is missing;
- the Procedure store persists one immutable compiled definition per name and version;
- the Procedure compilation service resolves only the Operation catalog;
- the Plan interface and graph group live Checks by Scenario slug and Check name.

These contracts explain why adding an invocation path only to the Check URI is insufficient. Roles,
Scenarios, Requirements, values, dependencies and UI identities also collide when the same child is
invoked more than once.

## Procedure interface

### Inputs

The roles whose compiled source is `plan-input` form the Procedure Input contract. When the Procedure
is engaged as a root, they are the closed root Plan Inputs. When it is composed, every one of them is
bound explicitly by the parent invocation.

An Input binding must preserve more than the scalar type:

- type;
- `one` or `many` cardinality;
- the complete `for` / `for each` parent topology after substituting child Input names with their
  parent bindings;
- the coordinates of a selected `on each` value.

TRUST must never correlate child and parent values by array position or by an inferred business key.

### Results

A Procedure may expose explicit Results. A Result is an existing typed role materialized inside the
Procedure and marked as returned:

```gherkin
Background: Plan context
  Given one reference "batch"
  And one reference "qualified person" declared by agent
  And one instant "certified at" returned
```

`returned` is an interface annotation, not a source of data. A compiled Result contract must expose
its name, type, cardinality and parent topology.

The compiler must establish all of the following:

- the role is materialized by exactly one provider Requirement in the child definition;
- a provider Check expanded `on each` still counts as one definition provider and may yield several
  runtime values;
- the Result is available on every path that can satisfy the child Procedure;
- a root Input, fixed role, agent declaration or unmaterialized role is not presented as an observed
  Result;
- a Result mapping to the parent preserves type, cardinality, topology and runtime coordinates.

When Scenario satisfaction supports alternatives, Result availability requires the following static
implication:

```text
child Procedure satisfied => Result provider Requirement satisfied
```

A Result provided by only one optional branch cannot be returned when another branch may satisfy the
Procedure without it.

A Procedure with no Results remains composable. Its only output is its satisfaction.

## Invocation grammar

The intended symmetry is readable:

```gherkin
Then Check "certificate" runs Operation "aviation.certificate-read"
```

```gherkin
Then Procedure "lockout" invokes Procedure "high-voltage-lockout"
```

The first quoted name is the local Requirement name. The second is the invoked Procedure name.

### Exact child version

The compiled proposal contains `procedureVersion`, `procedureDigest` and an immutable embedded child
definition, but the surface above does not select a version. The current grammar has no global import
or dependency section from which that version could be obtained.

At least one exact-version mechanism is therefore required. The smallest inline form is:

```gherkin
Then Procedure "lockout" invokes Procedure "high-voltage-lockout" version "1.2.0"
```

Other possible surfaces could declare Procedure dependencies outside the Requirement sentence. Any
such surface must still resolve one exact name and semantic version at compile time. No `latest`
selection can produce the promised immutable parent definition.

The digest is calculated and verified by TRUST; exposing it as an authored Gherkin value is a
separate product choice and is not required to select an exact published version.

**Product owner decision required:** choose where the exact child version is authored. Every example
and the compiled structure must then use that one form consistently.

### Bindings and materialization

An invocation uses the same explicit boundary vocabulary as a Check:

```gherkin
Then Procedure "lockout" invokes Procedure "high-voltage-lockout" version "1.2.0"
    on "intervention" as Input "intervention"
    using "installation" as Input "installation"
    and materializes "permit closure time" from Result "closed at"
    and must establish "the installation can be safely re-energized"
```

Every child Input is bound exactly once. An extra binding is rejected. A child Result becomes parent
context only through an explicit `materializes` clause.

`on`, `on each`, `on all` and `using` have these instance meanings:

- `on` creates one child instance from exactly one selected parent value;
- `on each` creates one independent child instance for every selected value and retains that value's
  parent coordinates;
- `on all` creates one child instance and binds the whole collection to a `many` Input;
- `using` selects one correlated value or one unscoped singleton;
- `using all` selects the correlated collection or one unscoped collection.

The existing Check binding algorithms demonstrate these one/each/all and correlation rules, but a
Procedure invocation must validate the whole child Input topology rather than one Operation schema.

**Product owner decision required:** decide whether Requirement names remain globally unique inside
one Procedure, like current Check names, or only unique inside their Scenario. Scenario-local names
require Scenario-qualified `requirement[...]` references outside that Scenario.

## Compilation and publishing

The Procedure compiler must receive or resolve exact compiled child Procedures in addition to exact
compiled Operations. An illustrative invocation contract is:

```ts
interface CompiledProcedureInvocation {
  kind: "procedure";
  name: string;
  scenario: string;
  procedure: string;
  procedureVersion: string;
  procedureDigest: string;
  childDefinition: CompiledProcedure;
  target: CompiledTarget;
  inputBindings: readonly CompiledProcedureInputBinding[];
  materializes: readonly CompiledResultMaterialization[];
  successReason: string;
}
```

The canonical embedded child definition, bindings, Result mappings and invocation semantics
participate in the parent definition digest. Source presentation remains outside semantic identity.

There are two compilation workflows with different consequences:

1. **Published-child resolution:** every child version is published before its parent. The runtime
   compilation service loads it from the immutable Procedure store. Publication order makes the
   dependency graph naturally acyclic, while validation still rejects inconsistent compiled input.
2. **Compilation bundle:** the compile request supplies child definitions or sources together. This
   permits compiling several unpublished Procedures, but requires explicit bundle identity, cycle
   detection and conflict handling at the public compile boundary.

The current service is synchronous over an in-memory Operation catalog while the Procedure store is
asynchronous. Either workflow changes that service contract.

**Product owner decision required:** choose whether a parent may compile only against already
published children or whether the public compiler accepts a multi-Procedure compilation bundle.

Compilation must reject:

- an unknown child Procedure or exact version;
- a child whose persisted digest or definition is inconsistent;
- a recursive composition cycle, direct or transitive;
- missing, duplicate or extra Input bindings;
- incompatible types, cardinalities or substituted parent topology;
- an unknown or non-returned Result;
- multiple providers for one parent role;
- a Result that is not guaranteed by every satisfying child path;
- consumption of a Result before the provider Scenario is a transitive prerequisite;
- duplicate runtime identity after canonical path construction.

The compiler emits the composed Procedure structure described here.

## Embedded Operation identity

The current compiled Procedure and Plan builder index embedded Operations by Operation name. Two
composed children can embed the same Operation identifier with different versions or semantic
digests.

Two coherent contracts are possible:

1. reject a parent definition containing two semantic definitions for the same Operation identifier;
2. resolve each leaf Check against the exact Operation definition in its own embedded child and use
   the digest, rather than a parent-wide map keyed only by Operation name.

Both preserve exact runner admission; they differ in which compositions are accepted and how the
compiled definition stores Operations.

**Product owner decision required:** choose the collision rule for the same Operation identifier used
through different child definitions.

## One Plan, with an instance graph

Engaging a composed Procedure creates one root Plan. It does not create a persisted child Plan, a
child engagement endpoint, a child Environment or a child Session.

One Plan does not mean that runtime state can remain a flat Check list. Each Plan revision needs an
immutable instance graph containing, at minimum:

- Procedure instances;
- Scenario instances;
- Requirement instances;
- bindings and local context identity;
- Result mappings and provenance;
- satisfaction and dependency edges;
- the leaf Check instances derived from the graph.

Requirement and Procedure state is derived by TRUST during Plan revision construction. Active
qualifications remain Check-only.

A conceptual instance tree is:

```text
plan:release-aircraft
  procedure:aircraft-release-to-service
    scenario:maintenance
      requirement:lockout
        procedure:high-voltage-lockout@1.2.0
          scenario:verification
            check:zero-energy
```

All child instances inherit from the root Plan:

- Environment;
- live or dry-run mode;
- current Session availability;
- Plan identifier and authority;
- root revision control.

## Runtime namespacing

The stable instance path must namespace all runtime-local identity, not only the Check URI:

- Requirement instance IDs;
- Procedure and Scenario instance IDs;
- Check definition and Check instance IDs;
- role IDs and the role names used in parent coordinates;
- agent declaration IDs;
- Result IDs and materialized parent provenance;
- Check-value provider references;
- role-value provider references;
- dependency edges;
- UI selection, grouping and ordering keys.

One possible conceptual path is:

```text
root
  /scenario:<parent-scenario>
  /requirement:<local-requirement>
  /target:<semantic-target>       # present for on each
  /iteration:<number>             # present for Repeat
  /scenario:<child-scenario>
  /check:<child-check>
```

The following remain boundary names rather than namespaced runtime keys:

- root Plan, Environment and Session identifiers;
- child Input and Result names inside the child interface;
- Operation identifiers and digests;
- a parent role name after an explicit Result materialization crosses the child boundary.

The same child may then be invoked twice without colliding even when its roles, Scenarios, Checks and
Operations have identical local names.

## Satisfaction and alternative Requirements

A Procedure Requirement is satisfied from the child Procedure's Scenario satisfaction expressions.
The parent Scenario observes its local Requirement as a TRUST-owned boolean; the agent does not set
it.

The current executable runtime equates Scenario completion with all Checks being qualified and Plan
completion with no open Checks. A satisfaction expression such as:

```gherkin
And the Scenario is satisfied when
    requirement["telemetry evidence"] || requirement["recorded finding"]
```

can make a Scenario true while one branch remains open. This affects three contracts:

- whether open Requirements of an already satisfied Scenario remain actionable;
- whether a dependent Scenario waits for every Check or for the prerequisite Scenario expression;
- whether Plan completion is based on open Checks or on root Procedure satisfaction.

Possible semantics include deactivating the unused open branch when the expression becomes true, or
allowing it to remain executable while the Scenario and downstream work advance. The latter permits
new Facts from the optional branch to alter context after downstream work has started and therefore
requires explicit cascade rules.

**Product owner decision required:** define the lifecycle and actionability of open Requirements after
an alternative Scenario expression becomes true. Until this is decided, composition with only the
existing `every Requirement` conjunction is fully defined, while alternative composition is not.

For `on each`, Requirement satisfaction exists per target coordinates. A parent Scenario expression
evaluated per item can combine only Requirement instances with exactly aligned coordinates. The
Scenario-level aggregate then determines whether every required scope is satisfied.

## Result provenance and cascade

When accepted Facts replace a qualification inside a child, the instance graph must identify the
exact affected suffix:

1. the affected child Check and dependent child Requirements reopen;
2. the child Procedure Requirement becomes unsatisfied if its completion expression becomes false;
3. mapped active Results lose availability;
4. parent consumers and dependent Scenarios reopen recursively;
5. sibling invocation instances whose dependency graph does not cross the affected node remain
   unchanged.

Facts and Snapshots remain immutable history. The active qualification set, Result availability and
current Plan revision are replaced.

The current `ProducedRoleValue` carries one `providerCheckUri`. A Procedure Result may represent
values from several expanded leaf Checks and also depends on the child Procedure's satisfaction.
The replacement runtime contract must therefore preserve either:

- the exact leaf provider URI for every mapped value plus the Procedure Requirement dependency; or
- a provider Requirement instance ID with the complete leaf provenance needed for precise cascade.

**Product owner decision required:** select the public and persisted provenance shape. The shape must
support both precise invalidation and readable Plan history.

## Declarations and scope

Agent-declared roles inside a child are declarations governed by the root Plan revision. They require
stable path-qualified identity because two child instances may declare the same local role name.

For an `on each` invocation, declaration values also retain the target's parent coordinates. The
declaration operation must expose the expected shape and missing declarations per invocation path.
The current flat object keyed by role name cannot represent this without a replacement contract.

Possible public shapes include:

- a flat object keyed by a stable semantic declaration path;
- a structured tree of invocation paths and local role names;
- an array of declaration entries with explicit instance ID, role and value.

**Product owner decision required:** choose the path-addressed declaration request and read shape.

## Semantic Check URI

The current URI contains root Procedure and version, Plan, Scenario, Check, Operation and optional
target expansion. Composition must add the stable invocation path while keeping the root Plan as the
authority boundary.

A conceptual URI is:

```text
trust://<authority>/<root-procedure>@<version>/<plan>
  /<parent-scenario>/<requirement>/<target?>/<iteration?>
  /<child-scenario>/<child-check>/<operation>
```

The exact segment order is a public contract. Dynamic target values must continue to use canonical
segments when safe and opaque deterministic hashes otherwise. Child names, local Requirement names
and iteration numbers must not create collisions or expose secret-like values.

Including child Procedure name/version as URI segments is optional for uniqueness because the root
version embeds immutable child semantics, but it changes readability and URI stability.

**Product owner decision required:** choose the final URI segment order and whether child
Procedure/version are visible or only available in Check metadata.

## Public RPC, MCP and Runner boundaries

Check admission, OTLP Fact ingestion and the Runner can retain their current conceptual boundaries:

- admission resolves one leaf Check URI;
- the grant carries one exact Operation and action Input;
- the Runner executes it and exports Facts;
- TRUST qualifies the leaf Check and rebuilds the root Plan revision.

The read boundaries need additional structure:

- `plan.read` must expose invocation path, Requirement kind and state, child Procedure identity,
  target coordinates, optional iteration, and mapped Results;
- `check.read` must expose the leaf's invocation breadcrumb;
- Plan history must distinguish definition-local names from runtime instance identity;
- the MCP Plan rendering must label duplicate local Check names by their invocation path.

`trust_procedure_read` currently returns only the root Procedure source stored on the Plan revision.
A Check inside an embedded child is not described by that source. Possible contracts are:

1. return the exact leaf Procedure source plus its invocation breadcrumb;
2. return the complete root-to-leaf source chain as labelled documents;
3. retain root-source reading and add a separate child-definition read surface.

All three affect pagination cursors and the meaning of "authoritative Procedure" for one Check URI.

**Product owner decision required:** choose how an agent reads the composed source that owns a leaf
Check.

## Checklist delta

Composition and existing materialization can make new leaf Checks appear in a new Plan revision. The
current finalization delta contains only `newlySatisfied`, `newlyOpened` and `unchanged`;
`newlyOpened` currently means a previously qualified Check invalidated by cascade, not a newly
instantiated Check.

Two public contracts are possible:

1. finalization returns only the verdict delta and the agent must call `plan.read` to discover the
   current actionable Checks;
2. the finalization contract is replaced with fields that distinguish newly added, removed, reopened
   and newly actionable Checks.

**Product owner decision required:** decide whether finalization itself must direct the agent to every
newly actionable leaf. This decision also applies to Repeat.

## Interface consequences

The current Procedure graph has one card per root Scenario and aggregates live instances by Check
name. The Plan checklist groups by Scenario and Check name. Both would merge two invocations of the
same child.

The interface needs a representation of the instance tree if composition is to remain understandable:

- parent Requirement row with child Procedure identity;
- expandable child Scenarios and Checks;
- target label for `on each` instances;
- Result flow across the invocation boundary;
- local and full semantic identity in expert mode;
- cascade visualization across child and parent boundaries.

The engagement UI still asks only for the root Procedure's `plan-input` roles. Child Inputs are bound
by the compiled parent and must not be repeated during engagement.

## Sessions and requalification

All child Checks use the root Plan Session. Closing or expiring it blocks admission across the whole
instance tree. Re-engaging the same Plan identity opens a new Session and resumes the currently
actionable leaf Checks; it does not create child Sessions or child Plans.

The public runtime currently permits explicit re-observation of a satisfied Check only in dry-run.
Consequently, acceptance evidence for replacement of an already active qualification uses dry-run
unless a separate live re-observation contract is introduced.

**Product owner decision required:** none for root Session inheritance. A separate decision is needed
only if live Plans must expose a new way to replace an already satisfied qualification.

## Explicit exclusions

This proposal does not introduce:

- a Runner operation that executes an entire Procedure;
- a child Plan resource or child engagement endpoint;
- dynamic child version lookup while a Plan is running;
- implicit Input binding by equal names;
- implicit Result export;
- a separate child Environment or Session;
- another admission, Fact, Snapshot or qualification engine;
- correlation by collection position.

## Technical classification

### Blocking contracts

- exact child version selection;
- recursive definition resolution and embedding;
- complete runtime namespacing;
- a Requirement/Procedure instance graph in Plan revisions;
- Procedure satisfaction independent of the current flat open-Check count;
- Result provenance and cascade across the invocation boundary;
- a path-addressed child declaration contract;
- composed-source reading for child Checks;
- collision handling for embedded Operations.

### Bounded implementation costs after those contracts are fixed

- parser and compiled-contract replacement;
- Plan builder recursion;
- URI builder extension;
- RPC/MCP read DTO replacement;
- UI tree, graph and history updates;
- schema replacement and public acceptance coverage.

## Public acceptance evidence

Acceptance coverage must pass through the public compiler, publishing, Plan, RPC, MCP, OTLP, Runner
and interface boundaries. It must cover:

- standalone and composed use of the same exact Procedure version;
- parent compilation with a missing or conflicting child version;
- exact child embedding and digest immutability;
- compile-time cycle and binding rejection;
- one, each and all child invocation scopes;
- two invocations of the same child with identical local role, Scenario and Check names;
- exact parent-topology substitution for child Inputs;
- path-addressed child declarations;
- explicit Result materialization and downstream admission;
- a Result provider expanded `on each`;
- rejection of a Result not guaranteed by every satisfying path;
- qualification replacement cascading from child to parent while preserving unrelated siblings;
- inherited live/dry-run, Environment and Session behavior;
- composed source reading from a child Check URI;
- duplicate Operation identifiers with the selected collision contract;
- UI and MCP rendering that distinguish invocation instances;
- confirmation that the Runner receives only leaf Checks and exact Operations.

## Product decisions still open

Before implementation, the product owner must resolve:

1. where the exact child version is authored;
2. published-child-only compilation or multi-Procedure compilation bundles;
3. global or Scenario-local Requirement name uniqueness;
4. collision behavior for one Operation identifier with different embedded definitions;
5. actionability of unused branches after alternative Scenario satisfaction;
6. persisted/public Result provenance shape;
7. path-addressed declaration request shape;
8. semantic Check URI segment order and child identity visibility;
9. composed source reading semantics;
10. whether finalization reports newly added/actionable Checks or requires a Plan reread;
11. whether live re-observation of a satisfied Check is introduced.
