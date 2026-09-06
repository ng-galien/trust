# Author a Procedure

## Prerequisites and outcome

Read the [Procedure reference](../../packages/trust-ui/src/docs/content/en/language/procedures.mdx)
and inspect the published Operations it will use. The result is a compiled draft
whose inputs, dependencies and qualification have been rehearsed, followed by an
authorized immutable publication. No Runner needs to be available to compile.

## Steps

1. Read [Dragon's root Procedure](../../assets/procedures/dragon-heist/05-game.feature)
   and [lock Procedure](../../assets/procedures/dragon-heist/01-lock.feature).
   Identify the root input `game`, the `tactic` agent declaration, mandatory scope
   table, Scenario prerequisites, Check qualifications and child Invocations.
2. Declare only actual root inputs. Fixed roles and Check-produced values are not
   supplied again at engagement. Agent declarations are replaced separately using
   the current Plan revision and a complete declaration snapshot.
3. Reference Operations and child Procedures through quoted `name@selector`.
   Select an exact version for intentional pinning in the source, or a standard
   range to select at engagement. There is no custom `latest` selector.
4. Express ordering with Scenario prerequisites and Check-observation dependencies.
   Write qualification against typed Facts using the closed expression language;
   a `js` DocString is not permission to execute arbitrary JavaScript.
5. Call `trust_procedure_compile` with the full `source` and optional `sourceName`.
   Ensure dependencies are available in the catalog. Resolve incompatibility in
   the draft: the highest matching version is selected before compatibility
   validation, with no silent fallback to an older matching version.
6. Rehearse using the [verification guide](verify-and-test.md), then call
   `trust_procedure_publish` with `source` and `sourceName` when authorized. Read
   the exact publication with `trust_published_procedure_read`
   (`procedure`, `version`). Do not confuse it with the paged, Check-scoped
   `trust_procedure_read` used during execution.

## Working examples

[Runner smoke](../../assets/procedures/09-runner-smoke.feature) has no root inputs:
`expected signal` is fixed as `"ready"`. Its Check qualifies the file Operation's
two produced strings. `signal = "blocked"` is valid data but gives
`NOT_VALIDATED`; `signal = "ready"` gives `VALIDATED`.

[Dragon Heist](dragon-heist.md) adds four nested levels and an independent branch.
An Invocation creates a child Plan automatically; the host still dispatches an
agent separately. Each Plan has its own intention chain. A child's completion
permits dependent parent work; it does not execute that work for the parent.

## Failure handling

Do not repair an incompatible dependency by rewriting its published version.
Publish a new compatible version or revise the caller's explicit reference.
Engagement pins the recursive composition, including delayed children and later
replacement child generations. Existing Plans do not adopt later publications.

Re-observation can invalidate dependent Checks. Read current Plan state rather
than assume that an earlier satisfied child still validates a parent invocation.
Escalation belongs to the Plan that requested it; distinguish its active
escalation from an ancestor's dependency blocker.

Public verification references: [versioning](../../packages/trust-runtime/acceptance/resource-versioning.acceptance.test.ts)
and [nested Plan depth](../../packages/trust-runtime/acceptance/child-plan-depth.acceptance.test.ts).
