# TRUST main-checkout consolidation — 2026-09-25

## Why consolidation was needed

The owner requested all TRUST development on main, deletion of the extra worktrees,
and a permanent prohibition of worktrees in every project. The inspection found three
registered auxiliary entries, with different code histories. This was a checkout divergence;
it did not establish duplicated or conflicting catalog records in the live databases.

| Original location | Contents at inspection | Resolution |
| --- | --- | --- |
| Main repository | `main` at `b7ec2cb`; 76 modified tracked files and 35 untracked files | Preserve existing work; integrate mobile additions here |
| `.codex/worktrees/9bce/trust` | Detached at the same commit; 15 modified tracked files plus 72 new files | Import all 87 files; combine the SDK exports; move the live service to main |
| `.codex/worktrees/bb4c/trust` | Clean detached commit `29555ef`; 27 files, +992/-58 | Retain original commit in history; keep the version-specific implementation already developed in main |
| `/private/tmp/agent-name-trust.eoPBRd` | Missing directory; obsolete registration at `26f5ffe` | Remove stale registration; its commit is already an ancestor of main |

The mobile changes contain the extension, React interface, rich Markdown and Mermaid,
subjects and source links, forms, templates, PostgreSQL storage, notification flow,
MCP commands, public acceptances and gateway support. They were previously uncommitted.

## The catalog conflict, precisely

The isolated catalog commit stores editable metadata by `(kind, name)`, across executable
versions, with a flat `tags` array and separate metadata service/store modules.
The main working copy stores metadata by `(kind, name, version)`, with structured
`classification`, an SDK-owned contract, public MCP query/update and explicit schema upgrade.
The latter matches the current repository's stated per-version product contract.
They cannot be combined by copying both sets of modules or SQL definitions.

The integration preserves the main implementation and its public acceptance coverage.
The older catalog commit is retained in the main history with this explicit resolution,
so its source and original tests remain recoverable without a second checkout.
This does not activate that old identity-wide schema in either retained database.

## Data preserved independently

- Main runtime: 58 Plans in `.trust/project/runtime.sqlite`; upgraded and restarted on main after the initial consolidation.
- Mobile runtime: 16 Plans in the retained mobile state directory; moved to the main build.
- Extension: the existing PostgreSQL container and named volume, on port 15439.
- Legacy PGlite directories remain as prior migration fallbacks; they are not live stores.
- Neither runtime initially had a `catalog_metadata_revisions` table. No competing
  stored catalog metadata was observed. The mobile runtime needed the additive table
  for the current main build. The project runtime subsequently received the same additive
  upgrade, with all rows of its 17 prior data tables verified unchanged.

Private recovery material is under `.trust/consolidation-20260925/`: complete tracked and
untracked source archives for all three checkouts, binary working-copy patches, a Git bundle,
SQLite online backups and integrity checks, the closed mobile state directory, launch
configuration backups and a PostgreSQL custom-format dump. These are ignored by Git.
Passwords and user responses are never included in tracked audit documents.

The relocation compares every old mobile SQLite table before/after the additive upgrade,
and compares the public project list, benchmark article, saved sandbox response and
subject with their pre-move values. All those comparisons passed. The PostgreSQL store,
Workbench credentials and Tailscale mapping stay at their existing locations.

## Verification record

- Main repository and extension builds passed.
- Public runtime acceptance: 15/15 passed (catalog, version pinning, MCP and extensions).
- Extension acceptance: 5/5 passed (article revisions, answers, push, subjects and upgrades).
- Initial mobile browser acceptance after import: 13/13 passed.
- Live main-checkout browser: project timeline and durable subject visibly rendered;
  the subject showed its three source links and three completed missions.
- Biome check passed with existing warnings; safe formatting/import fixes were applied
  to changed source files. Scrollable regions retain keyboard access, effect dependencies
  retain deliberate content/revision/retry triggers, and result keys use their identities.
- Full Code Moniker check passed with zero violations.

## Checkout removal and commits

After verifying each source archive byte-for-byte against the original worktree and confirming
that no live process used either checkout, both worktrees were removed and the missing-directory
registration was pruned. `git worktree list --porcelain` now lists only the main repository,
on branch `main`. The original catalog commit is an ancestor of main through an explicit
merge resolution; the retired testimony-agent commit was already an ancestor.

- `6c20832`: mobile extension and per-version catalog implementation consolidated on main.
- `11ac3dc`: preserve the earlier catalog prototype in main's history, retaining the current
  per-version implementation instead of installing its incompatible alternative schema.
- `72f85ef`: use the article locale for accessible Markdown table labels. A final browser
  run caught an undefined label variable introduced during accessibility cleanup; it was
  corrected and the extension passed its explicit TypeScript check before retesting.

The four catalog browser journeys passed after allowing Chromium to launch outside the
macOS sandbox. The initial sandbox attempt never reached the application. Final mobile
acceptance passed 13/13 after that correction; extension TypeScript checking passed.
The retained benchmark was opened in the live browser: version 9, comparison tables,
Mermaid diagrams and the independent review all rendered. The pre-commit Biome and architecture gates ran
normally; no hook was bypassed. Nothing was pushed to the remote repository.

The remaining untracked quiz inputs, answer state and helper files under
`environments/trust-test/` predate this consolidation. They remain in the main checkout and
in its recovery archive, excluded from these commits pending a separate review of retained
session data versus reusable source. No archive, response, key or database was committed.


## Retained baseline activation

The owner requested completion of the remaining schema activation and both running
interfaces. The main build and mobile extension build passed again. The project runtime
was stopped only after a copy rehearsal and verified SQLite/PostgreSQL backups.
The additive catalog migration preserved every row in all 17 existing data tables.
Runtime 4498 and the compiled web interface 4176 now run under launchd from main.
The browser displayed retained Plans; paginated RPC returned all 58. Catalog metadata,
Operation and Procedure reads succeeded. Four retained mobile API baselines (projects,
article, submitted response, subject) remained identical.

The first backup attempt used an incorrect PostgreSQL role and stopped before any
service interruption. It was rerun with the documented `postgres` administrator. A
strict API-envelope comparison subsequently detected a changed opaque pagination
cursor across restart; Plan contents were identical. Complete paginated reading and
the row comparison established preservation independently of that cursor.

Recovery material and verification are in `.trust/baseline-20260925-final/`. Earlier
backups remain retained. The user confirmed Tailscale access on the phone during this
activation. HTTPS from the Mac itself failed during TLS negotiation; investigation
was stopped at the user's direction after that phone confirmation. The existing
18444 mapping remains unchanged.

The owner explicitly deferred the pre-existing quiz/session files. They remain
untouched and untracked; this is a recorded exception to checkout cleanup, not
pending application implementation or a pending live database migration.
