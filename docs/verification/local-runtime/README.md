# Local runtime inventory


## Current consolidation — 2026-09-25

All development now uses the main branch in `/Users/alexandreboyer/dev/projects/trust`.
Git worktrees are forbidden. See [the consolidation audit](2026-09-25-main-consolidation.md)
for the original checkouts, preserved history, data boundaries and verification.

| Service | Address | Retained data | Current role |
| --- | --- | --- | --- |
| Project runtime / global MCP | `127.0.0.1:4498` | `.trust/project/runtime.sqlite` | 58 Plans; current main build, catalog schema activated |
| Project web | `127.0.0.1:4176` | None | Compiled main build, proxy to project runtime 4498 |
| Mobile web gateway | `127.0.0.1:4173` | None | Main-checkout build; existing Tailscale mapping on HTTPS port 18444 |
| Mobile runtime | `127.0.0.1:4318` | `~/Library/Application Support/TRUST/mobile-preview/state/runtime.sqlite` | 16 Plans; extension host, restarted from main |
| Extension PostgreSQL | `127.0.0.1:15439` | Docker volume `trust-mobile-pg-data` | Existing articles, subjects, forms, responses, templates and notifications |

The retained project runtime was upgraded and restarted on 2026-09-25. The additive
catalog migration was rehearsed on a consistent backup, then applied while the runtime
was stopped. All rows in 17 pre-existing data tables remained identical: 58 Plans,
253 Plan revisions, 24 published Procedures and 101 Facts. Integrity and foreign-key
checks passed. All 58 Plans are readable through paginated RPC; catalog reads succeed.
Private backups and verification records are in `.trust/baseline-20260925-final/`.
The opaque pagination cursor changes across restart; Plan contents remained identical.
The mobile runtime received that additive catalog-table upgrade during relocation; all rows
in every pre-existing table other than the schema digest were compared and remained identical.
The extension's PostgreSQL database was not migrated or replaced during this relocation.

The project runtime and compiled web preview are supervised by
`~/Library/LaunchAgents/com.trust.project-runtime.plist` and
`~/Library/LaunchAgents/com.trust.project-web.plist`. They use `.trust/project/start.sh`
and `.trust/project/start-web-baseline.sh`, respectively, sourcing the retained
`.trust/project/environment`. The web launcher runs Vite preview against `apps/trust-web`
on loopback port 4176; it does not seed or reset the database.

The mobile service is started by `~/Library/LaunchAgents/com.trust.mobile-preview.plist`.
Its launcher is `.trust/mobile-preview-start.py` in the main checkout, and its installation file is
`~/Library/Application Support/TRUST/mobile-preview/extensions.json`. The launcher reads the
existing private PostgreSQL password locally into the child environment; it does not print it.
The Workbench connection and its reader account are unchanged.

At the initial inventory, an additional PostgreSQL test container
`trust-mobile-pg-test-2026-09-25` was running on loopback port 61194, and a Module Federation
build broker was listening on port 16322. Neither is an additional production TRUST runtime.
No project UI was listening on port 4176. The sections below are dated historical records,
not evidence that their old UI processes are still running.

## Project entry point — historical 2026-09-12

The project UI is http://127.0.0.1:4176/plans. Its RPC, events and LSP proxy target is
http://127.0.0.1:4498, matching the repository MCP configuration.
The retained project database is `.trust/project/runtime.sqlite`.
Start commands are `sh .trust/project/start.sh` and `sh .trust/project/start-web.sh`.
Both launch scripts source `.trust/project/environment`; source that same file before using the public MCP helper or Runner CLI. The repository MCP configuration targets the same runtime.
The running tmux sessions are `trust-project-backend` and `trust-project-frontend`.
Do not point this UI at the empty templates preview or run the test seeding/reset
command against the project database.

The UI previously targeted port 4501 and `.trust/templates-preview/runtime.sqlite`.
That database has zero Plans. The project database contained nine Plans on 2026-09-12;
the UI proxy returned those nine Plans and the browser displayed `Plans · 9`, including
`templates-authority-correction-20260910` as Complete with 2/2 Checks.

## Shared development data and retained backup — 2026-09-18

The database at `.trust/project/runtime.sqlite` is a development database, but it is the
shared local authoring and execution history for Procedures used across the owner's
development projects. It is not disposable seed data. Do not reset or reseed it to work around
a schema mismatch. The project MCP on port 4498 and the project UI on port 4176 use this same
runtime and database.

Before restarting onto the runtime with child Plan Results, a consistent SQLite online backup
was saved at `.trust/project/backups/runtime-before-results-20260918.sqlite`. The snapshot
passed `PRAGMA integrity_check` and contained 17 Plans and 105 Plan revisions. The restart
required no migration or reseeding; afterward the MCP read all 17 Plans and the active database
still had 105 revisions with a clean integrity check. The backup is local and ignored by Git:
retain it, and replace it only with a deliberately created and verified newer snapshot when the
owner chooses to do so. Do not treat it as an automatically refreshed or temporary test file.

## Catalog metadata schema activation — prepared 2026-09-23

The catalog metadata implementation adds one append-only `catalog_metadata_revisions` table.
The retained project database still has the prior schema digest. Do not reset or reseed it.
After the implementation gates pass, identify the active database and stop the project runtime
under a controlled protocol. Use a new backup path and run:

```sh
node packages/trust-runtime/scripts/upgrade-catalog-metadata.mjs \
  .trust/project/runtime.sqlite \
  .trust/project/backups/runtime-before-catalog-metadata-20260923.sqlite
```

The command accepts only the exact preceding schema digest, makes a consistent SQLite backup,
verifies the backup, adds the table in one transaction and checks foreign keys and integrity.
It refuses to overwrite an existing backup. Before restart, compare Plan and published Procedure
counts with the pre-upgrade inventory; after restart verify `operation.list`, `procedure.list`,
`catalog.metadata.read` and retained Plans through the project MCP/RPC, plus SQLite integrity.
This activation was completed on 2026-09-25; see the current inventory above. The
commands in this historical section describe the upgrade protocol, not pending work.

## Archived SQLite inventory

At the 2026-09-12 inventory, only `.trust/project/runtime.sqlite` remained outside the archive;
the retained backup above was added later. Secondary runtimes 4318 and 4501 and the old UI 4173
were stopped. The following paths describe their original locations; retired files now live below
`.trust/archive/20260912-rationalization/retired/`, with SHA-256 hashes and original paths in
`manifest.json`.

Counts are physical stored Plan rows, read before archiving the databases.
WAL and SHM files are companions, not separate databases.

| Path below `.trust/` | Plans | Role |
| --- | ---: | --- |
| `project/runtime.sqlite` | 9 | Current project history |
| `dogfood/runtime.sqlite` | 17 | Older coordination history; separate runtime 4318 and UI 4173 |
| `templates-preview/runtime.sqlite` | 0 | Redundant preview, no longer used by UI 4176 |
| `server/runtime.sqlite` | 0 | Test environment state |
| `server-expression/runtime.sqlite` | 0 | Earlier expression test state |
| `trust.sqlite` | 0 | Earlier empty state |
| `dragon-heist/runtime.sqlite` | 0 | Separate demonstration |
| `dragon-heist/game/dragon-heist.sqlite` | n/a | Demonstration game database |
| `dragon-heist-before-semver-20260905/runtime.sqlite` | 5 | Historical demonstration copy |
| `dragon-heist-before-semver-20260905/game/dragon-heist.sqlite` | n/a | Historical game copy |

There are ten `.sqlite` files, including the historical demonstration copy, plus
three named runtime backup files under `server/` (`before-cleanup`,
`pre-red-green-20260822`, `before-local-admission-fix`). No file was deleted or merged.
This inventory is scoped to repository-local SQLite, not all host databases.

## Completed alignment

The old project process did not expose Templates. Its schema differed from the
current canonical schema only by the missing `source_templates` table. The runtime
was built from the current checkout. During a controlled stop, a database was
initialized using the canonical schema and the existing 16 tables were restored
unchanged. Every table schema and every row was compared before replacement.
Integrity and foreign-key checks passed. Original database files and a consistent
SQLite backup remain in the archive. No generic migration or schema-check bypass
was added to the runtime.

The same runtime port 4498 was restarted. Public RPC through UI port 4176 confirms
`template.list` returns an empty array and `plan.list` returns the nine original
Plans with their prior Check counts and states. Browser inspection confirms the
Templates catalog loads without `Method not found` and the New template dialog
opens its source editor. No demonstration templates were inserted.

The ordinary `npm run dev` command is a test-environment launcher with its own
state directory; it is not the retained project launch command above. Do not use
it to start another daily project instance. Acceptance environments must remain
explicitly scoped and stop after their run.
