# Local checks

Install workspace dependencies with `npm ci`. The local development tools also
require Code Moniker 0.11 or later and Lefthook (verified with 2.1.10) on PATH.
Run `npm run hooks:install` once per clone to install the versioned hook setup.

The pre-commit hook runs `npm run check` (Biome) and `code-moniker check .`.
Both commands are read-only and run against the complete working tree. They do
not format files, stage changes, or create a commit. Missing tools
or failed checks fail the hook. Biome warnings retain the recommended preset's
severity; errors block the hook. No warning is silently downgraded by this setup.

Run `npm run check:pre-commit` to exercise the same checks without committing.
Use `npm run format` or `npm run check:fix` explicitly for automatic formatting
or safe fixes, then inspect the diff before staging.

Lefthook itself temporarily hides unstaged hunks in partially staged files;
this is separate from the read-only commands. Prefer fully staged, reviewed
files for the hook. To check the untouched working tree directly, run
`npm run check` and `code-moniker check .` instead. Inspect the staged diff
separately: other unstaged and untracked files are not a staged-snapshot check.
The checks also do not replace TypeScript verification or
public acceptance tests. The full architecture check intentionally runs over
the workspace because dependency rules cannot be proven file by file.
