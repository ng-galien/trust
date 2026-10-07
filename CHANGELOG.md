# Changelog

## 0.2.0 — 2026-10-07

### Runtime and Plans

- A root Plan is cancelled with a reason; a started mission is stopped with a reason; a mission stays removable until an Attempt of its child Plan gives a verdict; the Plan of a relaunched or removed mission is closed.
- An extension selects and bounds the Plans it lists (`GET /extensions/<extension>/trust/plans?procedure=&mode=&workState=&limit=`).
- Controlled language for Procedure prose, with published vocabularies.
- Legacy extensions retired; delegation goes through native TRUST missions.

### Operations and Procedures

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
