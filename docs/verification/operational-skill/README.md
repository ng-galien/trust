# Operational skill evaluation

Scope: the distributed [TRUST operational skill](../../agents/SKILL.md), evaluated
through concrete authoring tasks on 2026-09-20. This changes documentation, not the
TRUST language or runtime. The entrypoint routes by intent; examples precede
technical references.

## Exercises and judgment

Three agents started with fresh conversation contexts, the skill path, an exercise
brief and an isolated output directory. They did not receive the intended sources
or the coordinator's analysis. The coordinator inspected their artifacts rather
than treating their self-assessment as proof.

| Exercise | Artifact and observed result | Skill adjustment |
| --- | --- | --- |
| Model two features and three discovered usages; append inline investigations | Correlated declarations and preserved missions were correct. Initial author stopped on Jira summary versus description; after the owner's design-scope clarification, authored an assumed Operation plus three Procedures. The coordinator compiled all four and exercised the declarations and two inline missions through public RPC. | Explicitly allow hypothetical Operation contracts during design; identify the field used by the example instead of implying summary and description are interchangeable. |
| Read two nested specification documents and record versioned acknowledgments | Two Operations and one Procedure compiled on the first attempt. Independent MCP simulation and RPC dry-run verified four Checks, per-record version bindings and negative/malformed cases. No external API execution by this evaluator. | Add complete disposable-runtime/RPC rehearsal; clarify actual Runner replay behavior. |
| Refine CSV export through external forms, develop backend/frontend and review | Five assumed Operations, parent and child Procedures, structured forms and handoffs, 20 JSON fixtures. Design preserves feature/revision/perimeter/requirements, uses scoped returned delivery references and reviews the combined candidate. Coordinator compiled the final seven sources; the complete lifecycle was not executed. | Add a compact lifecycle recipe and an ordinary external-gate example. Keep chosen approval, provenance and acceptance policies specific to the example method. |
| Follow-up transfer: a different form returns a boolean development decision | The external-I/O evaluator authored a new Operation and gate Procedure using the revised skill. Both compiled; projections of true/false and stale-version responses worked, and malformed string/null answers were rejected. Verdict expectations were reasoned from the guard, not claimed as executed by this evaluator. | Add explicit boolean-to-Produced conversion, with a type assertion, without another approval mechanism. |

The owner's clarifications were applied as exercise feedback: missing connectors
must not block a design, and an external confirmation is data for an ordinary
Check. Follow-up evaluations used that revised scope; they are not independent
first-pass measurements. These exercises support the skill's usefulness for these
tasks, not a statistical claim about all agents or all project methods.

## Improvements retained in the skill

- Intent-based routing and short modeling decisions in the entrypoint.
- [Related context](../../agents/recipes/related-context.md): actual parent-bound
  payloads, observed values and cardinality, rather than parallel flat arrays.
- [Delegation](../../agents/recipes/delegation.md): static or progressive work,
  inline sources, append-only acceptance, separate host dispatch and returned Results.
- [External I/O](../../agents/recipes/external-io.md): nested request/response
  projection, identity/version correlation and a real write-result criterion.
- [External gate](../../agents/recipes/human-confirmation.md): external yes/no or
  boolean answer → Operation observation → ordinary Check → prerequisite.
- [Feature lifecycle](../../agents/recipes/feature-refinement.md): known scopes,
  child results, final review and correction of a selected delivery.
- [Rehearsal](../../agents/recipes/rehearse-procedure.md): isolate both database
  and Operation catalog; complete public RPC request shapes.
- The English/French Scenario reference now permits Invocation-only Scenarios,
  matching the canonical grammar and executable examples.

## Verification performed by the coordinator

| Boundary | Result |
| --- | --- |
| Skill metadata validator | Passed |
| Complete sources extracted from the recipes | Nine sources compiled through public MCP/RPC |
| Related-context example | Exact declarations created the expected three Checks |
| External read/write dry-run | Correct inputs per record; wrong identity, empty description, wrong revision and rejection yielded negative qualifications; incomplete Facts left the Check unchanged |
| Static and inline delegation | Results absent after failure, imported after validation, withdrawn after requalification; append preserved the accepted child |
| External gate dry-run | Pending/no, wrong revision and wrong feature remained open; matching yes validated the Check |
| Boolean alternate projection | Documented conversion mapped true/false to yes/no |
| Exact rehearsal snippets | JSON-RPC envelopes and JavaScript admission/Fact/finalization example passed |
| Live public Runner against a temporary HTTP service | Two GETs and two POSTs persisted the correct per-record receipts; four Checks validated. An additional inline Procedure/Operation read produced a validated Result in its parent. |
| Packaged documentation | Public MCP discovery/read, pagination, all linked documents and use outside the checkout passed |
| Changed EN/FR reference | Fenced source blocks remain identical |
| Repository architecture gate | Complete Code Moniker report: zero violations |

Temporary exercise artifacts were retained for inspection under
`/private/tmp/trust-skill-eval-modeling`, `/private/tmp/trust-skill-eval-io` and
`/private/tmp/trust-skill-eval-feature`. Coordinator checks are in
`/private/tmp/trust-skill-check.mjs` and `/private/tmp/trust-skill-live.mjs`.
These are local evaluation artifacts, not installed product capabilities.

The real Maket/Jira integrations and the complete CSV lifecycle were not executed.
The retained project database and running shared server were not restarted or
modified. Documentation was repackaged and tested in separate runtime processes;
a read-only MCP check confirmed that the already running shared server still serves
the previous cached skill. The revised skill is available in the checkout and the
rebuilt package; activation in that shared process requires a separate reload/restart.
No commit or publication to a remote repository was performed.

## Project installation follow-up — 2026-09-21

Added a portable `assets/skills/trust-operations` entry and the packaged
`agents/install-in-project` guide. Installed that entry and the canonical bundled
Runner in MCP Maket's local `.agents/skills`, with project MCP/RPC/OTLP settings.
The entry reads the operational guide from the connected runtime instead of
copying its recipes into the consuming project.

The shared runtime on port 4498 was then restarted using its existing project
launch script, after a consistent backup at
`.trust/project/backups/runtime-before-skill-install-20260921-211515.sqlite`.
Before and after checks confirmed integrity, identical schema and all table
counts, including 58 Plans and 253 Plan revisions. MCP now serves the revised
scoping introduction and recipes; the earlier cached-document limitation above
is resolved. No demonstration Plan or Check was executed by this installation.

Both skill metadata validations, the two public documentation acceptance tests
and the complete TRUST Code Moniker gate passed. The Maket `npm run quality`
gate also passed. Local skill discovery by a newly opened Codex task still depends
on the host loading that project's skills and MCP configuration.
