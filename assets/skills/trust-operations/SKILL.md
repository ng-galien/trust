---
name: trust-operations
description: Use TRUST to model or refine Procedures, structure context, delegate work, connect external input/output and resume assigned Plans in this project. Read the connected runtime's operational recipes; use the separate trust skill for Check execution.
---

# Work with TRUST

## Start here

1. Read the project's `AGENTS.md` and any installed `references/project.md` beside
   this skill for project scope and connection settings.
2. Discover the connected TRUST MCP tools. Call
   `trust_documentation_read({"document":"agents/SKILL"})` and follow every
   returned cursor with the same document until `Complete: yes`.
3. Apply its scoping conversation when the method is unclear: clarify the outcome,
   perimeters, who works (user, one agent or several), external inputs/outputs,
   conditions for continuing and reserved unknowns. Reuse answers already given.
4. Select the relevant `I want to…` recipe. Read that document completely, then
   only the technical references needed for the task. A `trust-doc:///` link is
   a document identifier for `trust_documentation_read`, not a browser URL.

Example: for feature refinement, read
`agents/recipes/feature-refinement`; for an external confirmation controlling
continuation, read `agents/recipes/human-confirmation`.

## Author or execute

- For design, adapt the recipe to the agreed method. A missing connector can have
  an explicitly assumed contract; verify the real contract before execution.
- For an existing assignment, read its Plan first; do not engage a replacement.
- For Check execution, read the sibling `trust/SKILL.md` and use its packaged
  Runner with the exact supplied URI. The MCP and Runner must address the same
  runtime. TRUST's returned verdict determines progress.
- An external answer is observed by an ordinary Check; normal prerequisites gate
  continuation. Creating child Plans does not itself dispatch host agents.
- Preserve the authorized scope. Report drafts, publications, external actions and
  TRUST verdicts separately. Do not invent a project method or publish a design
  merely because this skill is installed.

If the MCP is unavailable, report the missing connection; do not silently use
another runtime. A repository copy may support explicitly offline authoring, but
cannot establish live Plan state. If recipes are missing, the operator must update
the runtime's packaged documentation; do not replace them with guessed syntax.
