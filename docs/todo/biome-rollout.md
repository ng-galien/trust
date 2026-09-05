# Biome rollout

Biome 2.5.12 is configured with the recommended preset and its original
severities. Maintained source and acceptance code are checked. Generated output,
dependencies, bundles, and non-code catalog data are outside the configured
source scope. No unsafe bulk fix or global rule disable was used.

## Result

The final coordinator-run pre-commit check passed with zero Biome errors across
387 files and zero Code Moniker violations across 358 files. Biome still reports
454 warnings and four informational diagnostics; they are not disabled or
reclassified. This is an error-free gate, not a claim that all quality debt is
resolved. The initial baseline contained 601 errors and 497 warnings.

Three local exceptions permit inserting strict-mode Mermaid SVG after Mermaid's
DOMPurify sanitization. Their source paths and adversarial browser evidence are
documented in `docs/todo/biome-rendering-review.md`. The proposed autofocus
exception was rejected and removed with the unused SearchInput option.

## Verification

- Coordinator-run all-workspace TypeScript check and `git diff --check` pass.
- Coordinator-run public SDK packaging and Code Moniker CLI acceptances pass.
- Backend public acceptances cover input validation, qualification, nested Plans,
  runner execution, and control-character handling through LSP and coordination.
- Frontend public acceptances cover editor authoring, graph selection/manual pan,
  simulation version changes, retries, resource-owned drafts, environment
  selection, documentation navigation, and adversarial Mermaid input.
- Dedicated field-level declaration/next-intention and schema feedback-loop
  scenarios remain coverage limits; broader passing journeys do not prove every
  such transition independently.

## Local hook

`lefthook.yml` runs read-only Biome and Code Moniker commands. Lefthook itself
temporarily hides unstaged hunks in partially staged files. The coordinator
observed the hook fail while errors remained and pass after their correction.
`npm run check:pre-commit` forces both commands even when nothing is staged.
See `docs/architecture/local-checks.md` for prerequisites, clone setup, and the
working-tree versus staged-snapshot distinction.

Commit and push are authorized after the final checks. No runtime reset or
user-preview restart was performed for this rollout.
General pure re-export shim discovery remains a separate follow-up,
not an unfinished part of the Biome gate.
