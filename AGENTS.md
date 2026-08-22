# TRUST current agent guide

Read this file first. The product owner is the product authority for TRUST. The A3 Maket functional
model records approved product decisions and must be kept aligned with the executable grammar,
runtime and public acceptances after every significant implementation milestone. A document or an
implementation never overrides an explicit product decision.

The active product language is **Plan + Sessions → Checks**. Product Action Contracts own the
reusable Fact shape. The runner executes the command or HTTP definition returned for one Check.
TRUST resolves a semantic Check URI, validates the delegation context, qualifies verified Facts and returns the
checklist verdict. An agent never infers whether its action advanced the Plan.

## Active repository map

```text
packages/trust-runtime/   shared runtime: domain, services, SQLite, RPC, MCP and OTLP
packages/trust-operation/ Operation types shared by the runtime and runner
packages/trust-procedure/ Procedure types and Gherkin compiler
packages/trust-runner/    one generic Check runner
assets/procedures/        authoritative grammar and product Action Contracts
assets/operations/        Operation catalog and design direction
environments/trust-test/  retained Kind environment: projects, cluster, manifests, connectors and scripts
```

## Non-negotiable design rules

- English is the only language for active code, runner instructions and metadata, CLI/MCP messages,
  technical documentation, and acceptance tests. Product terms and Action Contract identifiers
  must use their canonical English wording.
- The agent gives the runner only one semantic Check URI.
- Every completed attempt whose Facts are accepted returns the external action result and an
  explicit `VALIDATED` or `NOT_VALIDATED` checklist verdict with a useful reason. Without accepted
  Facts there is no qualification: a refusal, crash or transport interruption leaves the Check
  unchanged and the agent may invoke the runner again.
- A Fact batch missing any observation required by the Operation's complete Produced schema is rejected
  atomically before persistence. It produces no Fact, Snapshot, verdict or checklist delta; the runner
  may re-observe and resubmit without repeating a known external action.
- Replaying after missing Facts is the normal rule. TRUST deduplicates identical Facts and the
  resulting Snapshot, verdict and checklist delta. Rare actions that cannot safely be replayed after
  an unknown outcome require explicit human intervention; they do not justify a generic exactly-once
  engine in TRUST.
- A Check is either `OPEN` or `SATISFIED`. Facts and Snapshots are immutable history, but the
  qualification active in the current Plan revision is replaceable. New accepted Facts for one
  Check recompute that qualification and recursively make every dependent Check `OPEN` through
  Scenario prerequisites and Check-observation references; the agent resumes the same Plan from any
  Check whose dependencies are satisfied.
- The runner never qualifies Checks. `actionOutcome` is never qualification input.
- The runner receives the compiled Operation from TRUST. Shared Operation types belong to
  `trust-operation`; Shell and HTTP execution belong to `trust-runner`.
- Operations may create, update, delete, publish, transition, send or deploy when their Action Contract
  requires it. The runner acts with its own external permissions. Domain-specific idempotency or
  reconciliation may remain local runner safeguards, but advanced retry, shared journals, high
  availability and automatic recovery are not generic product gates.
- Gherkin plus a closed expression language owns Check intent, expected capability, typed qualification and semantic
  reasons. The generic server contains no procedure-specific business rule. A step may continue on
  the following lines when they are indented deeper than its keyword and are not a table row, doc
  string, comment, tag or keyword line; `@trust/gherkin` folds them before parsing and keeps every
  reported location on the physical source. `formatGherkinSource` (also the LSP formatter) re-flows
  long steps onto such lines at their connective words.
- Delegation is refused before the external action until every compiled prerequisite Scenario is
  validated and every Check referenced by an observation has an active `VALIDATED` qualification.
- TRUST owns URI and Session resolution, delegation grants, explicit environment selection, Fact validation, qualification,
  immutable snapshots and checklist deltas. A grant validates and correlates the requested Check,
  Operation, context and attempt; it is not proof that the external action occurred.
- Plan engagement accepts only the procedure/version, Plan identifier, environment and the closed
  set of compiled root Plan inputs. Fixed roles and future Check-produced roles are never repeated.
  Roles explicitly compiled as agent declarations are replaced after engagement only through the
  closed, revision-checked declaration operation; it cannot write roots, fixed roles or Check
  outputs. V1 has no auto-fill, generic context patch, rich engagement UI or organizational input policy.
- A dry-run Plan follows the same Check, Fact, qualification and cascade rules as a live Plan, but
  operator Facts enter through RPC and no Environment values are delegated. Only a dry-run may
  explicitly re-observe a satisfied Check. Live Facts enter through OTLP from the runner.
- A procedure may compile and publish independently of runner availability. Plan engagement validates
  its closed business inputs and creates the initial Checks. Attempt admission validates the current
  Check, Session, dependencies, Action Contract and Environment without a release registry or
  deployment lifecycle.
- RPC and MCP call the same runtime functions. MCP never proxies RPC or exposes raw DTOs.
- Do not create Proof, Evidence or Binding resources, SQL per requirement, manual references,
  `checks.refresh`, compatibility adapters or another product module.
- Use OpenTelemetry traces only. Logs and metrics are outside the governance contract.
- The Awilix-injected database driver is a singleton. Runtime code never fetches the container.
- There are no schema or data migrations before release. Replace the schema and reseed manually.
- No `MEMORY.md` or Codex memory is used for this project.

## Integrated documentation

The interface documents TRUST itself: `packages/trust-ui/src/docs` — MDX pages under `content/<language>/`
(the path below the language is the URL below `/docs`; front matter `title`, `summary`, `order`, `draft`,
`screen`), components (`Callout`, `Details expert`, `Term`, `PageCards`, `Snippet`, `Diagram` = mermaid,
`Screenshot`), figures, and `captures/` (real screenshots). English is the reference; a missing translation
falls back to it; `content/fr` mirrors `content/en` page for page (same fences byte for byte, same
components — an acceptance test checks it). Hub pages stay conceptual (no protocol names, no verdict codes); technical detail lives
in detailed pages or `<Details expert>` blocks. Tone: technical, not promotional. Fenced ```gherkin
blocks marked `operation` / `procedure` must compile — `apps/trust-web/acceptance/docs.acceptance.spec.ts`
compiles them on the runtime and checks every referenced screenshot exists. Screenshots are regenerated with
`npm run docs:capture` in `apps/trust-web` (Playwright project `docs-capture`, seeded runtime): elements
marked `data-doc="…"` in the interface give the callout boxes stored next to each PNG. The header's
help button links each screen to its documentation page (`helpPages` in `shell/header.tsx`). The
documentation also builds as one self-contained HTML file (`npm run build:docs` / `npm run zip:docs` in
`apps/trust-web`, entry `docs-site.html` → `@trust/ui/docs`, hash routing, opens from `file://`).

## Verification

Only acceptance tests at public boundaries are allowed. Do not add or run unit tests.

Public evidence comes from the real runtime process through RPC, MCP, OTLP, the runner CLI and the
test environment. A build or typecheck is useful qualification but is never accepted as behavioral
evidence.

Use Code Moniker as the single architecture analyzer when relationship or dependency evidence is
required. Do not create a parallel import checker.

Commit only when explicitly requested.
