# Operational guides for agents

Already assigned a Plan? Read [Execute and coordinate](execute-and-coordinate.md)
and the linked Runner instructions. Engagement, publication and installation are
separate tasks; an execution assignment does not authorize them.

Otherwise choose the task you need:

| Task | Guide |
| --- | --- |
| Define an external action and its produced values | [Author an Operation](author-operation.md) |
| Define governed execution and qualification | [Author a Procedure](author-procedure.md) |
| Select and exercise the right verification boundary | [Verify and test](verify-and-test.md) |
| Follow a Plan without inferring progress | [Execute and coordinate](execute-and-coordinate.md) |
| Implement an integration and its page | [Author an extension](author-extension.md) |

For a complete, non-prescriptive worked example, read [Dragon Heist](dragon-heist.md).
Its game structure, storage and nesting depth are not requirements for your solution.

These English guides and the canonical English reference pages are packaged with
the runtime. Use `trust_documentation_list` to discover them and
`trust_documentation_read` to follow document identifiers and page cursors.
Packaged `trust-doc:///` links identify documents for that reader, not browser URLs.
Repository-only references are labeled explicitly. The IHM retains its translated
reference pages; these task guides are not yet rendered there.

## Before using a guide

Discover the tools offered by the connected runtime and read their input schemas.
Examples describe the public contracts in this checkout, not a promise that a
different installed runtime has the same capabilities. Obtain authorization before
publication, live execution, installation or modification of an external system.
Use a disposable validation Environment for examples, never reset a shared preview.

The product language is **Plan + Sessions → Checks**. Operations produce values;
the Runner reports Facts; TRUST qualifies Checks. A successful command, HTTP
response, game move or worker response is not a checklist verdict. An external
system still owns its domain state and applicable consistency rules.

Published Operation and Procedure versions are immutable and cannot be deleted.
Keep edits as drafts and publish a new version. References use `name@selector`
with exact SemVer or standard node-semver ranges; engagement pins the entire
composition. A new publication does not change an existing Plan.

## Sources of authority

- [Project decisions and verification rules](../../AGENTS.md).
- [Operation language reference](../../packages/trust-ui/src/docs/content/en/language/operations.mdx)
  and [Procedure language reference](../../packages/trust-ui/src/docs/content/en/language/procedures.mdx).
- [Public extension contracts](../../packages/trust-extension-sdk/README.md).
- [Runner instructions](../../assets/skills/trust/SKILL.md).

Read the full referenced source when a guide directs you to it. The guides explain
tasks; they do not redefine the grammar, exported contracts or tool schemas.
The second reusable example is [coordination delegation](../../extensions/coordination/DELEGATION.md).
Delegation and Dragon Heist are supplied pedagogical examples, intended as built-in
example bundles. Their catalogs and extensions exist; generalized bundle
distribution and installation remain deferred. Neither example prescribes the
architecture of every Procedure or extension.
