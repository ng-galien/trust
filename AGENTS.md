# TRUST current agent guide

Read this file first. The product owner is the product authority for TRUST. The A3 Maket functional
model records approved product decisions and must be kept aligned with the executable grammar,
runtime and public acceptances after every significant implementation milestone. A document or an
implementation never overrides an explicit product decision.

The active product language is **Plan + Sessions → Checks**. Product Action Contracts own the
reusable Fact shape. The runner executes the command or HTTP definition returned for one Check.
TRUST resolves a semantic Check URI, validates the delegation context, qualifies verified Facts and returns the
checklist verdict. An agent never infers whether its action advanced the Plan.

## Delegating work

For operational authoring and execution guidance, start with the
[operational skill](docs/agents/SKILL.md), then read the relevant task reference.

Delegation uses native mission collections and child Plans. Read
[the delegation recipe](docs/agents/recipes/delegation.md). Host dispatch assigns an
existing child Plan to a worker; declarations, Checks and returned Results remain
in TRUST. Corpus organizes specifications and references these Plans. Do not create
a second mission registry, claim store, response store or execution lifecycle in Corpus.

## Active repository map

```text
packages/trust-runtime/   shared runtime: domain, services, PostgreSQL/PGlite, RPC, MCP and OTLP
packages/trust-operation/ Operation types shared by the runtime and runner
packages/trust-extension-sdk/ standalone public runtime and extension contracts (no server implementation)
packages/trust-procedure/ Procedure types and Gherkin compiler
packages/trust-runner/    one generic Check runner
packages/trust-shell/     common server shell, CLI and Runner deployment
apps/trust-desktop/       Electron shell over the common server
assets/procedures/        authoritative grammar and product Action Contracts
assets/operations/        Operation catalog and design direction
environments/trust-test/  retained Kind environment: projects, cluster, manifests, connectors and scripts
```

## Retained development data

The owner's development runtimes hold Plans, published Procedures and execution
history. They are **not** disposable test fixtures. Do not reset, reseed, replace
or delete retained stores or their database companion files in response to a
schema mismatch. Preserve existing private backups; replacing or removing one
requires the owner's explicit direction.

Before changing a retained runtime, identify its actual active configuration,
database and owning process, make and verify a consistent backup, use a
data-preserving approach, and verify public MCP/RPC and retained data afterward.
Keep installation addresses, inventories and backup records outside Git. See
[retained runtime maintenance](docs/verification/local-runtime/README.md).

## Non-negotiable design rules

- Canonical language types belong to `trust-operation` and `trust-procedure`;
  public runtime/extension contracts belong to `trust-extension-sdk`. The runtime,
  runner, LSP, UI and extensions import their owners' types instead of declaring
  independent copies. Intentional projections derive from those types. Internal
  persistence models and UI-only state remain distinct from public contracts.
- Total dispatch over a closed canonical union uses its shared exhaustive matcher
  beside the type definition. Consumers must not use assertions or a last-variant
  fallback to hide missing cases. Selecting a canonical variant, including a
  variant predicate in a controlled consumer, uses the matcher. Ordinary value
  guards and transport routing remain separate responsibilities.
  TypeScript exhaustiveness does not replace validation at a JSON boundary.
- Import canonical public contracts directly from their package, and matcher
  values from its `/match` entrypoint. Canonical package facades are intentional;
  consumer-level contract re-export barrels are not. Derived presentation types
  remain valid and do not become a second contract authority.
- Extensions compile against the standalone SDK without compiling the server.
  The SDK must not import runtime, UI or LSP implementation; the existing extension
  boundaries remain in force.

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
- Plan engagement accepts only the procedure/version, Plan identifier, environment, immutable Plan
  metadata (`title`, `labels`, `annotations`) and the closed set of compiled root Plan inputs. Fixed roles and future Check-produced roles are never repeated.
  Roles explicitly compiled as agent declarations are replaced after engagement only through the
  closed, revision-checked declaration operation; it cannot write roots, fixed roles or Check
  outputs. V1 has no auto-fill, generic context patch, rich engagement UI or organizational input policy.
- A dry-run Plan follows the same Check, Fact, qualification and cascade rules as a live Plan, but
  operator Facts enter through RPC and no Environment values are delegated. Only a dry-run may
  explicitly re-observe a satisfied Check. Live Facts enter through OTLP from the runner.
- A procedure may compile and publish independently of runner availability. Plan engagement validates
  its closed business inputs and creates the initial Checks. Attempt admission validates the current
  Check, Session, dependencies, Action Contract and Environment; registry synchronization and Runner
  deployment prepare those inputs but never participate in admission or qualification.
- Operation and child Procedure references use quoted `name@selector`, with exact SemVer versions
  or standard node-semver ranges, never a custom `latest` tag. Engagement resolves and pins the entire
  recursive composition; later publications do not change existing Plans, delayed children, resumed
  execution or replacement child generations. Select the highest matching version before compatibility
  validation and refuse incompatibility rather than silently falling back.
- Published Operation and Procedure executable versions are immutable and cannot be deleted, even when unused.
  Source edits to the executable definition are unpublished drafts and must publish under a new version.
  The catalog presentation for each exact published version (human title, existing Feature description
  and classification tags) has independent, revision-checked editorial updates. Those updates do not
  recompile the definition, replace the source snapshot, alter an engaged Plan or change SemVer.
  Discarding a draft is not deleting a published version. Catalog interfaces group one identity with its versions in the detail view.
- A Procedure may declare mission collections whose entries select an installed Procedure or supply
  inline canonical Procedure and Operation sources. TRUST validates and pins each complete composition
  when the mission is accepted, before creating its child Plan. Inline definitions are persistent Plan
  history, not reusable catalog publications. Static composition retains engagement-time pinning.
  Accepted missions are append-only: identical resubmission preserves their resolution and child;
  changing an accepted mission is refused. Removing one is accepted only while no Attempt was ever
  admitted in its child Plan or a descendant. Empty collections remain waiting for work.
  Agents read child Plans and use the existing Runner and escalation paths. Host dispatch remains
  outside TRUST; this capability adds no cancellation or post-escalation policy.
- Registry sources are named configuration stored by the runtime. An HTTP source points directly to a
  `trust.registry-index@1` index; a Git source clones one repository (optionally at one ref) and reads
  `trust-registry.json` at its root. Synchronization is explicit, verifies every artifact digest and
  declared identity, validates the complete batch, then imports Operations before Procedures.
- The server CLI and Electron application use `trust-shell` as their common shell. Runner deployment
  installs the complete package at one exact absolute directory and replaces an existing directory
  atomically; the Electron menu must call that same implementation.
- RPC and MCP call the same runtime functions. MCP never proxies RPC or exposes raw DTOs.
- Do not create Proof, Evidence or Binding resources, SQL per requirement, manual references,
  `checks.refresh`, compatibility adapters or another product module.
- Use OpenTelemetry traces only. Logs and metrics are outside the governance contract.
- The Awilix-injected database driver is a singleton. Runtime code never fetches the container.
- There is no generic schema or data migration framework before release. Disposable test databases
  may be replaced and reseeded manually; this does **not** authorize resetting the retained shared
  development database described above. Handle its incompatibilities through an explicit,
  data-preserving protocol.
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

For the design decisions behind the executable rules and the distinction between
project-wide policy and owner-local fragments, read
[rule curation](docs/architecture/rule-curation.md). Start with the relevant
`code-moniker rules learn` topic, then inspect the actual project rules with
`code-moniker rules show . --profile canonical-contracts --details`.
Use the complete `code-moniker check . --report` gate before handoff; a focused
profile is an investigation aid, not a replacement for the other boundaries.

Only acceptance tests at public boundaries are allowed. Do not add or run unit tests.

Public evidence comes from the real runtime process through RPC, MCP, OTLP, the runner CLI and the
test environment. A build or typecheck is useful qualification but is never accepted as behavioral
evidence.

Use Code Moniker as the single architecture analyzer when relationship or dependency evidence is
required. Do not create a parallel import checker.

Commit only when explicitly requested.

## Git checkout policy

Git worktrees are strictly forbidden in every project owned by Alexandre. Never create a worktree, including for isolation, delegation, testing, or a new task. Work in the existing main repository checkout on its main branch. Configure delegated tasks to use that local checkout. Preserve existing changes and coordinate edits in the shared checkout.
