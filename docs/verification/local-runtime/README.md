# Local runtime inventory — 2026-09-12

## Project entry point

The project UI is http://127.0.0.1:4176/plans. Its RPC, events and LSP proxy target is
http://127.0.0.1:4498, matching the repository MCP configuration.
The retained project database is `.trust/project/runtime.sqlite`.
Start commands are `sh .trust/project/start.sh` and `sh .trust/project/start-web.sh`.
Both launch scripts source `.trust/project/environment`; source that same file before using the public MCP helper or Runner CLI. The repository MCP configuration targets the same runtime.
The running tmux sessions are `trust-project-backend` and `trust-project-frontend`.
Do not point this UI at the empty templates preview or run the test seeding/reset
command against the project database.

The UI previously targeted port 4501 and `.trust/templates-preview/runtime.sqlite`.
That database has zero Plans. The project database contains nine Plans. On 2026-09-12,
the UI proxy returned those nine Plans and the browser displayed `Plans · 9`, including
`templates-authority-correction-20260910` as Complete with 2/2 Checks.

## Archived SQLite inventory

Only `.trust/project/runtime.sqlite` remains outside the archive. Secondary runtimes 4318 and 4501 and the old UI 4173 were stopped. The following paths describe their original locations; retired files now live below `.trust/archive/20260912-rationalization/retired/`, with SHA-256 hashes and original paths in `manifest.json`.

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
