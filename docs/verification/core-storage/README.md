# Core PostgreSQL / PGlite implementation — 2026-09-25

## Delivery and activation status

The core persistence implementation is delivered in the existing `main` checkout.
PostgreSQL and embedded PGlite share the schema, stores and qualification rules.
Each database has one active runtime owner; many clients/agents/Runners and pooled
transactions are supported within that runtime. Independent installations use
independent databases. No extension storage implementation was migrated.

The retained project and mobile installations have **not** been activated on the
new storage. Their original databases, previous backups and configurations remain
in place. Their public health endpoints at ports 4498 and 4318 were still healthy
after rehearsal. The dedicated coordination runtime at 4510 is separate. At the
pre-commit verification handoff, no commit, push, package publication or production
cutover had been performed.

Read [core storage](../../architecture/core-storage.md) for the implementation
contract and [conservative import](../storage-import.md) for exact commands,
preflight refusals and activation/rollback boundaries.

## Implemented behavior

- One PostgreSQL DDL and schema metadata version; two narrow Kysely adapters.
  SQLite remains only as the explicit import source and legacy schema verifier.
- JSONB for all 18 document/list fields, boolean flags, internal UUIDs, checked
  bigint counters and millisecond runtime instants. External timestamp spellings,
  source text and historical identifiers/digests remain exact.
- Canonical child comparison fingerprints preserve generations despite object
  key reordering. Snapshot equivalence uses a bounded digest and exact comparison.
- Composition-root transaction locking precedes Attempt locks. Atomic Fact
  ingestion, duplicate publication, engagement, finalization, replay and coherent
  assembled Plan reads run against both engines.
- Explicit storage selection in direct runtime and common CLI/Electron shell.
  Legacy SQLite configuration is refused instead of starting empty storage.
- Dedicated PostgreSQL ownership session with loss detection and pool shutdown;
  exclusive PGlite ownership marker based on filesystem identity, including case
  and symlink aliases. Crash recovery remains explicit and fail-closed.
- Asynchronous initialization returns HTTP 503 until the application is ready.
  The development manager runs the compiled runtime directly and waits for its
  graceful exit before resetting a disposable PGlite directory.
- Conservative all-table SQLite import with a new private consistent backup,
  Operation archive, schema and conversion checks, transactional insertion,
  complete row comparison and verified identity sequence high-water marks.

The shared dependency gate also found a pre-existing `pg` range disagreement.
Consumers now consistently pin the already installed `8.23.0`; PGlite is pinned
at the already installed `0.5.8`. No installed engine version was changed.

## Public evidence

Only public acceptance journeys were run. They use real runtime processes with
RPC, MCP, OTLP, packaged Runner, import CLI and common shell CLI boundaries.

| Campaign | Observed result |
| --- | --- |
| Initial complete PGlite runtime campaign | 102 passed; one tmux startup failure subsequently corrected; one optional PostgreSQL Trial skipped and subsequently run |
| Initial complete PostgreSQL runtime campaign | 111 passed; the same tmux startup failure subsequently corrected; three conditional skips covered separately where applicable |
| Corrected startup, health and manager journey | 5 passed, including reset, retained SQLite refusal, live reload and runtime reuse |
| Common CLI/Electron shell implementation | 6 public CLI acceptances passed |
| PostgreSQL Runner Trial | Passed separately with both PGlite and PostgreSQL core storage on a disposable external database |
| Conservative import with retained-copy continuation | 9 acceptances passed on each engine |
| Final ownership/import/manager boundary campaign | 15 passed; two conditional cases covered in their separate lanes |
| Final PostgreSQL public health | 2 passed |
| Repository build | Passed; existing Vite chunk-size warnings remain |
| Complete Code Moniker gate | 684 scanned files, zero violations |
| Shared dependency specifications | Aligned |
| Biome on changed implementation/test files | No errors; existing non-null assertion warnings remain in acceptance code |
| Whitespace check | Passed |

The initial full campaign results above are retained honestly rather than recast
as a fresh zero-failure full-suite run. The isolated failure was a real startup
race: the server bound its port before asynchronous storage initialization but
had no request handler yet. An early health request could wait forever. A second
manager reset exposed npm exiting before its child released storage ownership.
Both defects were corrected and the complete affected public journey passed.
Other domain cases were not unnecessarily rerun after startup-only changes.

Execution logs remain local under `/tmp/trust-storage-*-acceptance.log`,
`/tmp/trust-storage-manager-final.log`, `/tmp/trust-storage-final-boundaries.log`,
`/tmp/trust-storage-postgresql-trial.log`, `/tmp/trust-storage-build.log` and
`/tmp/trust-storage-architecture-final.log`. The skipped embedded crash test in
the PostgreSQL lane is covered in the embedded lane; PostgreSQL owner-session loss
is covered in its server lane. The retained-copy import is separately enabled
with explicit source/Operation paths.

## Retained-copy verification

The coordinator independently read the final import manifests. All 18 table
comparisons match after codec decoding in every listed archive.

| Source / target | Plans | Revisions | Child generations | Facts | Snapshots | Attempt / revision watermark |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Project → PGlite | 65 | 291 | 37 | 121 | 121 | 128 / 291 |
| Project → PostgreSQL | 65 | 291 | 37 | 121 | 121 | 128 / 291 |
| Mobile core → PGlite | 18 | 55 | 13 | 18 | 18 | 18 / 55 |

Final project archives are at:

- `/var/folders/xm/kkcg93zd02vdbhbz67hvgkc00000gn/T/trust-retained-import-acceptance-nNRQcv/archive`
- `/var/folders/xm/kkcg93zd02vdbhbz67hvgkc00000gn/T/trust-retained-import-acceptance-FIRtk0/archive`

The mobile core archive is at
`/private/tmp/trust-mobile-core-import-7Qy7Oc/archive`.
These private archives contain source snapshots and manifests. Keep them private.
They are rehearsal artifacts, not substitutes for a fresh final-cutover backup.
Test-owned PostgreSQL target databases were dropped after verification.

The project continuation acceptance reads all 65 Plans, 26 published Procedures
and all 121 Snapshot IDs through paginated public history. Appending a mission to
the copied `hall-npm-server-preparation-2026-09-25` Plan creates a new revision and
one new child while preserving its four existing child identities/generations,
including after restart, on both engines. No external action is executed.

An older pinned definition in `agent-delegation-20260909` already lacks
`materializes` in its SQLite source. Reading survives import; adding a mission
remains refused on both engines. This pre-existing historical-definition limit is
preserved and documented rather than silently rewritten. It is separate from
storage conversion or row preservation.

## Coordination and product model

Three implementation missions use the dedicated coordination runtime and real
Runner claim/submit/observation transitions:

- `storage-implementation-foundation-20260925`
- `storage-implementation-runtime-20260925`
- `storage-implementation-import-20260925`

All three missions were independently reviewed and their final observation returned
`COMPLETED` with `VALIDATED`; each Plan reached `COMPLETE` with four satisfied Checks.
The board remains at
`http://127.0.0.1:4180/extensions/coordination?coord.project=trust-core-storage`.

The Maket A3 document **TRUST — Modèle fonctionnel · Itération 02** was aligned:
SQLite-specific actor labels on pages 3–5 now refer to the core store; page 11
records the approved ownership, independent-installation and explicit-import
boundaries. Layout checks passed for all four changed pages; page 11 was visually
inspected. The document distinguishes the approved decision from activation.

## Remaining deployment choice

Choose a target for each retained installation and a maintenance window before
stopping writes and taking its final fresh import. Concrete embedded targets are
`.trust/project/pglite` and the mobile shell state's `pglite` directory. PostgreSQL
requires independently provisioned core databases, distinct from extension data;
the server and database identities must be selected explicitly. Multiple such
databases can live on the same PostgreSQL server.

Preserve each installation's semantic authority, ports, Operation catalog and
private configuration. Remove the retired `TRUST_DATABASE_PATH` setting only as
part of that selected activation. Keep original SQLite files and backups. Before
new target writes, rollback is a configuration return; after new target history,
SQLite is stale and an explicit recovery is required. No live switch is implicit
in this delivery.
