# Biome checks

The repository uses Biome's recommended preset and configured severities.
Maintained source and acceptance code are checked. Generated output, dependencies,
bundles and non-code catalog data are outside the configured source scope.
Do not apply unsafe bulk fixes or globally disable rules to obtain a passing gate.

Local exceptions require a concrete, bounded justification. See
[rendering safety boundaries](biome-rendering-review.md) for Mermaid insertion
and [React hook transitions](react-hooks.md) for lifecycle-sensitive dependencies.
A zero-error run does not establish that all warnings or quality debt are resolved.

## Local hook

`lefthook.yml` runs read-only Biome and Code Moniker commands. Lefthook temporarily
hides unstaged hunks in partially staged files. `npm run check:pre-commit` forces
both commands even when nothing is staged. See
[local checks](../architecture/local-checks.md) for prerequisites, clone setup and
the working-tree versus staged-snapshot distinction.

Typechecking and lint are static checks. Public acceptances remain necessary for
behavior changed by a refactor. Keep exact execution results and source digests
in the mission response or private run records rather than this reusable guide.
