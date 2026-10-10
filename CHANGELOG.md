# Changelog

## 0.2.0 — 2026-10-07

### Runtime and Plans

- A root Plan is cancelled with a reason; a started mission is stopped with a reason; a mission stays removable until an Attempt of its child Plan gives a verdict; the Plan of a relaunched or removed mission is closed.
- An extension selects and bounds the Plans it lists (`GET /extensions/<extension>/trust/plans?procedure=&mode=&workState=&limit=`).
- Controlled language for Procedure prose, with published vocabularies.
- Legacy extensions retired; delegation goes through native TRUST missions.
- Plan reads run in one read-only `REPEATABLE READ` snapshot instead of taking the shared composition lock: a suspended reader no longer blocks a writer, and the pool initializes each PostgreSQL connection before checkout so a failed initialization no longer keeps a connection taken. The child synchronization reads each scenario's prerequisites once.
- The runtime and the Runner declare the MCP revisions they speak (2025-11-25, 2025-06-18, 2025-03-26): `initialize` answers with the requested revision when it is one of them and with 2025-11-25 otherwise; a request whose `MCP-Protocol-Version` header names another revision is refused with 400 and the list; `serverInfo` carries the package version.

### Operations and Procedures

- The npm package carries no Operation and the server seeds none: an installation starts with an empty catalogue and authors or imports its Operations (registry sources, `trust_operation_save`). The example catalogue stays in the repository under `assets/operations`.
- `acceptance.vitest-run@1.0.0` runs the Vitest tests a mission contract names in any project of the workspace; `workspace.script-gate@1.0.0` runs the quality gate a project declares in its package scripts; `review.checklist-check@1.1.0`.
- Draft Operations that observe test duration, stability and selection.
- `delegation.topology-check@1.0.0`: a Verilog library of delegation elements (`assets/delegation/`) describes who delegates to whom, in what order, who arbitrates and how the work is delivered; the check compiles the topology with Icarus Verilog, refuses an incoherent one with its reason and returns the missions, owner decisions, delivery and order to declare in a Plan.

### Interface

- Plan cancellation interface.
- Corpus workspace: host support, rights, interface rules gate and authoring guide.

### Tests and maintenance

- The runtime acceptance tests run under Vitest with shared fixtures (one runtime per file instead of one per test).
- Maintenance findings (`maintenance/`): a findings file per analysis axis, checked by `scripts/maintenance-findings.mjs` against the repository and the base commit of the file; the findings of the October 2026 campaign are recorded.
- Continuous integration builds the packages and runs the acceptance suites on every push to `main`.

### Corpus extension (separate repository, pointer updated)

- Only the current framework Procedure `corpus-thread-framework@0.9.0` is served: a Plan approves one revision, carries its requirements and declares its delivery; older versions, their code and their tests are removed.
- Delivery Procedures `delivery-git@1.0.0`, `delivery-workspace@1.0.0`; Maket Procedures `maket-verify@1.0.0`, `maket-commit@1.0.0`.
- Interface in the reference visual language: compact Plan card with folded missions, Plan follow-up and mission pages, neighbourhood as a grouped list, Plan history, thread states Open / In progress, views panel over the list, corpus choice when a thread is opened.

## 0.1.0 — 2026-10-02

First npm release of TRUST: one package, `@ng-galien/trust`, bundles the runtime, web interface, Runner and agent skills.
