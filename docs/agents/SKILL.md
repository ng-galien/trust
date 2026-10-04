---
name: trust-operations
description: Model TRUST Procedures, related context, progressive delegation and external system input/output; author and verify Operations, or execute assigned Plans. Use for operational TRUST work, including turning a feature into governed work. Route Check execution to the Runner skill.
---

# Use TRUST for the next task

## Clarify the method before choosing a guide

When the intended Procedure or its scope is unclear, interview the user before
committing to a model. Use a **grill-me-style scoping conversation**: investigate
the decisions that change the method, following the user's answers rather than
running a fixed questionnaire. Start from the request and existing decisions;
do not ask again for information already supplied.

| Unclear decision | Example question |
| --- | --- |
| Purpose and outcome | What should this Procedure establish when it is complete? |
| Scope | Which feature or perimeters does it cover, and what remains outside? |
| Who does the work | Will you perform the work yourself, will one agent do it, or will several agents receive delegated parts? |
| External systems | Which systems supply inputs or receive outputs, and what can we read or change there? |
| Conditions for continuing | Which observations or decisions allow the next stage? Does a user answer in an external system gate it? |
| Remaining unknowns | What must be decided now, and what can be investigated later through reserved work? |

Ask the most consequential unanswered question first, normally one at a time.
Offer concrete alternatives when helpful; investigate a vague or contradictory
answer before choosing a structure. Do not infer multi-agent execution, an external
service or an approval policy merely because a recipe illustrates one.

Stop questioning when the next modeling step has a clear purpose, boundary,
participants, data sources and success criterion. Summarize those decisions
briefly, distinguish explicit design assumptions and deferred unknowns, then select
the relevant guides below. Reopen a question if a later discovery changes that
scope. Do not require every future detail to be settled or repeat permission that
the user has already given. In a design exercise, an assumed connector contract
can be sufficient; actual execution needs its real contract.

The name refers to the interview pattern described by
[Matt Pocock's grill-me](https://github.com/mattpocock/skills#1-the-agent-didnt-do-what-i-want).
This guidance is self-contained; no additional skill installation is required.

## I want to…

Read the matching example, adapt its names, business rules and external contract,
then verify it. These examples describe particular methods, not a mandatory
development process for every project.

| I want to… | Start here | Concrete result |
| --- | --- | --- |
| Use TRUST from another project | [Project installation](install-in-project.md) | Discoverable local skills, connected MCP and packaged Runner |
| Refine a feature, delegate backend/frontend work, then review | [Feature lifecycle](recipes/feature-refinement.md) | Connected form model, stage gates, scoped child Results and review feedback |
| Model a feature, its usages and their descriptions | [Related context](recipes/related-context.md) | Complete Procedure, correlated declaration payload, expected Check inputs |
| Delegate known work or investigate a discovery | [Delegation](recipes/delegation.md) | Child and parent sources, inline mission, host handoff, Result mapping |
| Read a document or write a result in another system | [External input/output](recipes/external-io.md) | HTTP Operations, nested JSON projection, verified stored reply |
| Make continuation depend on an external answer, such as a user's confirmation | [External gate](recipes/human-confirmation.md) | An ordinary Check observes yes/no; its prerequisites control what follows |
| Resume an assigned Plan | [Execution card](recipes/run-plan.md), then the [Runner skill](../../assets/skills/trust/SKILL.md) | Supplied Check URI, explicit TRUST verdict |
| Diagnose a compiler error or refine a source | [Procedure authoring](author-procedure.md) / [Operation authoring](author-operation.md) | Corrected draft using canonical grammar |
| Prove behavior | [Verification](verify-and-test.md) | Compilation, simulation, dry-run or live evidence, labelled accurately |
| Reuse an authoring pattern | [Templates](templates.md) | Editable rendered source; publication stays separate |
| Add an extension | [Extension authoring](author-extension.md) | Extension using the public SDK |
| Write or change a screen of TRUST or of an extension | [Interface authoring](author-interface.md) | Screen on the theme tokens and both catalogues that passes the interface gate |

For a **design or comprehension exercise**, assume or draft a missing Operation's
interface and example response, label that assumption, and continue designing the
Procedure. An unavailable connector is an implementation gap, not a reason to stop
the model. For actual execution, verify the installed contract first. Do not claim
that an assumed Operation or endpoint already exists.

## Make the first modeling decision

```text
Value known when starting?          → root input
Value chosen later by the agent?    → declared by agent
Value read from the outside world?  → Check materializes a Produced field
Value obtained by delegated work?   → Invocation materializes a returned Result
Value belongs to another value?     → for / for each, with explicit parent bindings
Unknown work may appear?            → reserve a mission collection in the Procedure
Rich document already lives outside?→ keep its reference; observe the fields the method needs
```

Example: a feature has several usages; each usage has its own description.
Use related roles for these relationships. Keep the full editable document in its
external system. TRUST records observed values and qualifies the authored criteria.
A worker's prose or an HTTP success does not establish Plan progress.

## Use the connected runtime

For an existing Plan, read that Plan before considering engagement. Distinguish
your assigned Plan from its ancestors and children; creating a child does not
authorize host dispatch or assign its execution to you.
For detailed state transitions, use [execution and coordination](execute-and-coordinate.md).

Discover the connected runtime's tools and read the schemas for the calls you
need. Use `trust_documentation_list` to locate references and
`trust_documentation_read` to read them, following page cursors to the end of the
selected document. Start with `trust_documentation_read({"document":"agents/SKILL"})`;
a recipe is `{"document":"agents/recipes/delegation"}`. Packaged `trust-doc:///` links are document identifiers for
that reader, not browser URLs. If a required reference is marked repository-only,
read it from an available checkout; report missing access when it blocks the task.

## Preserve the execution contract

- Use the assignment's scope and existing authorization. Authoring alone does not
  authorize publication, live Trials, additional Plans or host dispatch.
- Use the canonical [Operation](../../packages/trust-ui/src/docs/content/en/language/operations.mdx)
  or [Procedure](../../packages/trust-ui/src/docs/content/en/language/procedures.mdx)
  reference for authoring, and [public SDK contracts](../../packages/trust-extension-sdk/README.md)
  for extensions. Apply [project rules](../../AGENTS.md) when modifying this repository.
- Treat Operations as producers of values, the Runner as the reporter of Facts,
  and TRUST as the authority for Check qualification. Never infer Plan progress
  from a command result or worker response.
- Keep published versions immutable. Leave source changes as drafts unless
  publication is authorized; publish a new version. Use exact SemVer or standard
  ranges in `name@selector` references. Existing Plans retain their pinned composition.
- Keep accepted missions immutable too. Inline sources remain in Plan history;
  consolidate them into reusable catalog versions only when authorized. A mission
  whose child Plan never admitted an Attempt can be removed on an explicit decision
  (see the delegation recipe); history keeps it.
- Use approved disposable resources for validation. Do not reset a shared preview
  or run an unrelated demonstration as part of an ordinary task.

Read [Dragon Heist](dragon-heist.md) only when asked to run that demonstration or
when its nested composition clarifies the current task. Native delegation needs
no coordination extension or external mission database.

## Finish the assignment

Stop at the outcome defined by the selected reference and the assigned scope.
Report the affected source or Plan identifiers, observed results, and unresolved
blockers. Distinguish a compiled draft, a publication, an external action and a
TRUST verdict. Never describe a test as passed unless it ran in this task.
