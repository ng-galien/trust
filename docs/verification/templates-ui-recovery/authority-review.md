# Template authority correction: coordinator review

Plan: `templates-authority-correction-20260910`.
Procedure: [templates-authority-correction@1.0.0](authority-procedure.feature).

The assigned worker implements the bounded corrections; the coordinator guards scope and does not infer completion from worker statements. The host dispatches the worker. This is a verification Plan, not a PostgreSQL coordination mission.

## Accepted implementation boundary

- Keep pure template validation and literal materialization in the existing canonical template owner. Runtime and LSP consume those functions; neither maintains a second set of parameter rules or size limits.
- Keep complete Procedure and scope-fragment recognition and validation in `trust-procedure`. Diagnose unsupported trailing source instead of silently accepting it. Do not extend the accepted Procedure grammar.
- Keep the LSP responsible for protocol context and original/projected positions. Materialized authoring context must preserve catalog exclusion without rescanning literal replacement text.
- Distinguish an absent default from an explicit empty default using shared UI controls. Preserve existing persistence, revisions, literal substitution, immutable publications and Plan qualification boundaries.
- Remove obsolete built-in example claims from active MCP descriptions and documentation. Do not seed replacement examples.
- Extend the existing editor architecture boundary and public CLI acceptance to the template editor. No parallel architecture analyzer or weakened rule.

The worker must stop dependent work and escalate any uncertain semantic, ownership or scope choice to the coordinator with the conflict, affected files, options and forbidden continuation. The coordinator may resolve implementation choices within existing decisions; an unresolved product decision belongs to the product owner. This communication path does not fabricate an admissible runtime escalation attempt.

## Required evidence

The frozen-checkout interface Check runs the runtime build, public LSP stdio acceptance, template RPC/MCP acceptance, template and ordinary authoring Playwright journeys, public architecture CLI acceptance, and the complete Code Moniker gate. Required behavior includes:

1. Parameter declaration invariants agree at save and LSP boundaries, including unused, undeclared and malformed cases.
2. Unsupported trailing fragment steps and scenarios cannot disappear from diagnostics.
3. A replacement value containing `{{literal}}` remains literal in the materialized preview and receives destination-language analysis.
4. Saving an explicit empty default through the UI permits a public render request that omits that value; absence remains distinct.
5. Existing concurrency, tombstone/recreate, one-pass rendering, limits, catalog exclusion, offset mapping and ordinary authoring regression remain intact.
6. MCP descriptions match the actual catalog; the editor wrapper is covered by the existing architecture rules.

Independent review checks all seven criteria: `catalog`, `detail`, `editor`, `navigation`, `workflow`, `authority`, `domain`. It records findings, screenshot hashes and the exact acceptance/source digest. The coordinator executes the review Check only against that same checkout. No commit or push is authorized by this mission.
