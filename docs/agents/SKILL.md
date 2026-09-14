---
name: trust-operations
description: Author and verify TRUST Operations, Procedures and extensions, or coordinate and execute assigned TRUST Plans. Use for TRUST operational work; route Check execution to the packaged Runner skill. Do not use for generic software tasks merely tracked by a Plan.
---

# TRUST operations

Determine the requested task, assigned Plan or source, and authorized scope from
the user's request and current context. Preserve existing authorization; ask only
when a required input or permission is missing. Authoring does not authorize
publication, and a Plan assignment does not authorize installation or engagement
of additional Plans.

## Select the instructions

Read only the reference needed for the current task:

| Assignment | Instructions |
| --- | --- |
| Create or revise an external action and its Produced schema | [Author an Operation](author-operation.md) |
| Create or revise governed intent, dependencies and qualification | [Author a Procedure](author-procedure.md) |
| Create, customize or instantiate reusable authoring templates | [Create and instantiate templates](templates.md) |
| Verify a proposed change or investigate a failed acceptance | [Verify and test](verify-and-test.md) |
| Execute or coordinate an assigned Plan | [Execute and coordinate](execute-and-coordinate.md), then the [Runner skill](../../assets/skills/trust/SKILL.md) for Check execution |
| Implement an extension or its page | [Author an extension](author-extension.md) |

For an existing Plan, read that Plan before considering engagement. Distinguish
your assigned Plan from its ancestors and children; creating a child does not
authorize host dispatch or assign its execution to you.

Discover the connected runtime's tools and read the schemas for the calls you
need. Use `trust_documentation_list` to locate references and
`trust_documentation_read` to read them, following page cursors to the end of the
selected document. Packaged `trust-doc:///` links are document identifiers for
that reader, not browser URLs. If a required reference is marked repository-only,
read it from an available checkout; report missing access when it blocks the task.

## Configure ordinary Environment values

For authorized Environment setup, call `trust_environment_list` first. Use
`trust_environment_save` with `environment` and the complete `values` map to create
or replace ordinary configuration. Omitted ordinary values are removed. Never put
secrets in this map; credential management remains on the operator RPC/UI surface.
Use `trust_environment_remove` only for requested removal. It refuses Environments
with attached credentials so that MCP cannot delete secrets indirectly.
Read the list again to verify the result. Use `trust_operation_environment_list`
with a draft source or exact Operation identity to check compatibility before execution.

## Preserve the execution contract

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
- Use approved disposable resources for validation. Do not reset a shared preview
  or run an unrelated demonstration as part of an ordinary task.

Read [Dragon Heist](dragon-heist.md) only when asked to run that demonstration or
when its nested composition clarifies the current task. Read the
[coordination methodology](../../extensions/coordination/DELEGATION.md) when using
that extension. Neither example prescribes other Procedures or extensions.

## Finish the assignment

Stop at the outcome defined by the selected reference and the assigned scope.
Report the affected source or Plan identifiers, observed results, and unresolved
blockers. Distinguish a compiled draft, a publication, an external action and a
TRUST verdict. Never describe a test as passed unless it ran in this task.
