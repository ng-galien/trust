# Core storage impact study: concurrency, adapters and runtime boundaries

Date: 2026-09-25. Status: study; no functional implementation, migration, acceptance run or live activation performed by this mission.

Coordinator review: the [consolidated recommendation](storage-impact-2026-09-25.md#recommended-final-schema-versus-import-transition) distinguishes the final JSONB-based semantic model from temporary import safeguards. Its three owner-level decisions define deployment/value-domain/activation boundaries; codecs, lock order, type mappings and index mechanics remain engineering work, not separate approval gates.

TRUST delegation: `storage-impact-concurrency-20260925`, assignee `storage_concurrency_analyst`, runtime `http://127.0.0.1:4510`. The packaged Runner claimed the mission with `COMPLETED` and `VALIDATED` (Attempt `8e9fa772-49f5-4cfe-91b6-4b9d5f5fe41c`). The coordinator owns final observation and integration. This report complements the table/column inventory and the coordinator's import study.

## Accepted direction and scope

PostgreSQL is the reference SQL model; PGlite serves autonomous embedded use and PostgreSQL server serves shared/concurrent use. One persistence model and common PostgreSQL DDL are the target. SQLite remains only an explicit import source during transition. Extension databases retain their own ownership. Bidirectional synchronization is outside scope.

The important impact is not only converting SQLite DDL. The current single-connection driver serializes transactions that will overlap on a PostgreSQL pool. Existing JSON, timestamp, boolean and generated-number conversions also depend on SQLite's returned values. Those assumptions must be made explicit before implementation.

## Evidence and verification limits

The main checkout was inspected without editing functional files. Installed dependencies are Kysely `0.29.5` and PGlite `0.5.8` (`node_modules/kysely/package.json`, `node_modules/@electric-sql/pglite/package.json`). Local dependency implementation was read, including PGlite's shipped source map, rather than assuming all versions share the same parsers.

Code Moniker review followed the installed skill and `rules learn refs`; `rules show . --profile canonical-contracts --details` returned 10 rules / 49 compiled rows. Its first workspace snapshot was stale. A refreshed `symbol.usages` and a subsequent graph read used generation 3 of `/Users/alexandreboyer/dev/projects/trust`. Exact `createSqliteDatabase` usage has one incoming import from `runtime.ts`. The incoming graph for `database/database.ts` returned all 48 matching caller records (48/48), covering stores, `PlanRuntime`, Plan composition/read services and runtime DI. Members were bounded to 60/191; there were three unlinked external dependency references and no unresolved references reported in this selected graph. These are indexed structural observations, not an exhaustive concurrency proof or a full architecture gate.

No database experiment or new test was run. Race descriptions below are source-derived risks, not reproduced production failures. Official documentation was consulted on 2026-09-25; implementation must pin and verify the actual supported PostgreSQL/PGlite versions. The coordinator owns the complete `code-moniker check . --report` handoff gate.

## Current transaction and persistence behavior

| Boundary | Verified implementation | Migration impact |
| --- | --- | --- |
| Database construction | `packages/trust-runtime/src/database/sqlite.ts:13–54`: one `DatabaseSync`, WAL, foreign keys, 5-second busy timeout, explicit SQLite parameter conversion | Replace construction and SQL dialect; do not carry PRAGMA semantics or integer booleans into PostgreSQL |
| Ownership/lifetime | `packages/trust-runtime/src/runtime.ts:100–169`: Awilix singleton; `destroy()` disposer; optional injected `Database`; startup initializes services | Prepare an asynchronous database before dependent services initialize; preserve exactly one owned instance and explicit disposal |
| Transaction scheduling | Installed `kysely/dist/dialect/sqlite/sqlite-driver.js:14–33`; `dialect/sqlite/sqlite-adapter.js:4`; `driver/runtime-driver.js:22–23,42–67` | SQLite advertises a single connection and Kysely locks its acquisition until release; ordinary runtime transactions use `BEGIN`, not `BEGIN IMMEDIATE` |
| Schema preparation | `database/sqlite-schema.ts:364–402`: `BEGIN IMMEDIATE` only for initial schema creation/explicit catalog upgrade | Distinguish preparation locking from domain transaction locking; startup must refuse incompatible retained schemas |
| Revision persistence | `plan/store.ts:29–124`: insert immutable revision/checks, conditional advance of `plans.current_revision` | Atomic transaction still required. A uniqueness/CAS failure must roll back the entire revision and expose a meaningful conflict |
| Lock primitive | `plan/store.ts:147–155`: conditional no-op `UPDATE plans SET current_revision = revision` | It acquires a PostgreSQL row write lock too, but causes a new tuple; use a deliberate row-lock API and reread protected state after acquisition |
| Attempt lock | `attempt/store.ts:57–65`: no-op pending-state `UPDATE … RETURNING` | Preserve pending-state exclusion and returned row behavior; unify lock order with Plan locking |
| Fact acceptance | `plan/runtime.ts:902–980`: transaction locks Attempt, validates entire batch, appends all Facts/receipts | Keep atomic rejection. No partial Facts, qualification or revision after a missing Produced field |
| Qualification | `plan/runtime.ts:1029–1285`: locks Attempt; reads current Plan/dependencies; writes Snapshot, revision, active qualification, Attempt result, child synchronization; events follow commit | Acquire all relevant governance locks before deciding from current state; keep the entire database outcome atomic |
| Sessions | `plan/runtime.ts:1580–1612`, `session/store.ts:15–79` | Open-session lookup/create and close must have a defined ordering relative to admission/ingestion |
| Catalog editorial revisions | `catalog/metadata.ts:90–141`: latest revision plus insert, PK protects concurrency, reread maps conflicts | Existing conflict mapping is useful precedent; do not replace it with unsafe last-writer-wins upserts |
| Published Procedures | `procedure/store.ts:18–60`: read-before-insert and compare immutable source/digest | Concurrent identical publication needs conflict-aware reread; concurrent different definition must remain a domain conflict |

## Concurrency findings and proposed controls

PostgreSQL's default Read Committed isolation uses a fresh snapshot for each statement. A transaction alone does not make a sequence of reads a stable snapshot; row locks and unique constraints solve different problems. Serializable transactions can detect conflicting executions, but applications must handle aborted transactions. These are engine properties, not reasons to introduce an external-action retry engine. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

### 1. Lock order is currently inconsistent

Admission locks the Plan at `plan/runtime.ts:1512–1518`, then an existing Attempt at `1540–1543`. Finalization locks the Attempt at `1036`, then writes the Plan revision at `1216`; interruption likewise locks Attempt at `1002` before releasing a Plan intent at `1017`. With two PostgreSQL sessions, a retry admission holding the Plan can wait for an Attempt held by finalization, while finalization waits for that Plan. The single SQLite connection suppresses this overlap.

Proposal: choose and apply one lock order across admission, ingestion, finalization, interruption, declarations, escalation and session changes. A Plan/composition lock first, then Attempt, then dependent records is a candidate. Reread the Plan's mutable intent and session state after obtaining the lock: `replaceDeclarations` reads `chainedPlan` before the lock (`717–749`), so an unchanged revision alone does not prove that its captured intent reservation is still current. PostgreSQL recommends consistent lock acquisition order to avoid deadlocks. [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)

### 2. Distinct Attempts can collide on shared Facts

`fact/store.ts:44–62` checks whether a content-addressed Fact exists, then inserts it; the caller locks only its own Attempt. Two Attempts with the same Fact identity can both see absence. The primary key prevents corrupt duplication, but one transaction can fail instead of recognizing an identical replay.

Proposal: use `INSERT … ON CONFLICT DO NOTHING` followed by a reread and semantic collision check; retain receipt uniqueness and the whole-batch transaction. Do not use `DO UPDATE` on immutable Facts. Locking one Attempt still protects its `(attempt_handle, fact_index)` receipt collision. Public acceptance must cover identical content submitted through distinct Attempts, not only concurrent submissions to one handle.

### 3. Finalization needs Plan-level serialization, not only Attempt-level serialization

Two different Attempts can lock different rows and derive `nextRevisionNumber = current + 1` (`plan/runtime.ts:1111`) from the same Plan revision. Revision uniqueness and the conditional head update prevent both heads from succeeding, but the losing path may encounter a generic constraint error after qualification work. Locking/reloading the current Plan before qualification lets the second finalizer re-evaluate current actionability and dependencies. Concurrent finalization of the *same* Attempt remains idempotent via the stored finalization result (`1036–1051`).

### 4. Read-before-create needs deliberate conflict behavior

Concurrent engagement of the same slug (`plan/runtime.ts:244–267`), concurrent Procedure publication (`procedure/store.ts:18–60`) and session renewal (`plan/runtime.ts:1585–1604`) can both observe absence. Unique keys protect stored identity; they do not automatically provide the intended idempotent response. Retain and explicitly handle those keys. For sessions, keep the partial unique `one_open_session_per_plan` (`sqlite-schema.ts:186–188`) and serialize renewal under the Plan lock. Test close/expiry versus admission and Fact acceptance: `close` currently updates a Session outside the Plan transaction (`plan/runtime.ts:334–342`), while ingestion checks Session state after locking its Attempt (`943–952`). The permitted linearization order must be stated, not inferred from HTTP arrival times.

### 5. Parent/child composition is a multi-Plan concern

`plan/children.ts:19–68` reads ancestry, supersession and current child revisions; `readComposition` recursively loads children (`71–125`); finalization synchronizes children in its transaction (`plan/runtime.ts:1266`). An admission or finalization must not make a decision from a child generation concurrently superseded elsewhere. Per-Plan locking alone is insufficient without a strategy for these cross-Plan predicates.

Proposal to evaluate: serialize governance mutations for one composition under a root-Plan lock, then lock descendants in a fixed order. Independent root Plans remain concurrent. An alternative is carefully scoped Serializable transactions with bounded retry of database-only work. The exact choice is a design decision requiring acceptance evidence; do not introduce a global database lock or claim multi-runtime scalability before measurement.

### 6. Trigger predicates do not replace concurrent serialization

The existing escalation guard triggers query `plan_escalations` on Attempt/revision insertion (`sqlite-schema.ts:319–337`), and composition pinning compares previous revisions (`145–156`). Translated PostgreSQL triggers must use PL/pgSQL functions with explicit `RETURN NEW`/exception behavior, but a cross-row `EXISTS` check can still race with a concurrent transaction unless both paths share the proper lock or isolation rule. Preserve immutable-row triggers and FK/UNIQUE/CHECK constraints as database defenses; verify concurrency through public operations. [PostgreSQL trigger functions](https://www.postgresql.org/docs/current/plpgsql-trigger.html)

### 7. Coherent reads and shared live visibility remain separate

`readComposition` makes multiple dependent queries; a pool can observe several committed revisions across those reads. Evaluate read-only Repeatable Read for assembled Plan views/history projections that promise a coherent revision, or explicitly pin all referenced revisions. Use short transactions and ensure all queries use their transaction object.

`plan/events.ts:9–22` explicitly implements a process-local event buffer. Moving SQL to a shared PostgreSQL server does not make another runtime's SSE clients aware of commits. `operation/catalog.ts:39–40,96,170` also retains an in-memory/file-backed Operation catalog. Decide whether shared use means multiple users behind one runtime or multiple independently running runtimes. The latter needs catalog visibility and invalidation work, not just a database URL. Notification-driven rereads may be appropriate; notifications must never become the source of truth. No HA, durable event journal or bidirectional synchronization is implied by this study.

## Driver and serialization contract

Kysely types do not transform driver values. The installed PostgreSQL driver passes parameters directly to `pg` and maps DML `rowCount` to `BigInt` (`node_modules/kysely/dist/dialect/postgres/postgres-driver.js:109–123`). Store checks such as `numUpdatedRows === 1n` must work in both target adapters.

| Value | Current/target behavior observed | Proposed common contract |
| --- | --- | --- |
| JSON object | Stores write `JSON.stringify` and parse text; `pg` and PGlite parse JSONB into JS values | Change row types and readers together, use one explicit JSON input codec; avoid parsing an already-decoded object |
| JSON root array | `pg/lib/utils.js:63–65` turns a JS array into a PostgreSQL array, while objects use `JSON.stringify` (`82`) | Explicitly serialize JSON arrays as JSON text before binding a JSONB column. Do not remove all stringify calls mechanically |
| JSON scalar string | PGlite JSON serializer treats string input as pre-serialized JSON | Encode strings as JSON strings explicitly; distinguish a JS string value from encoded JSON |
| Missing/null | `pg` maps top-level `undefined` and `null` to SQL NULL; JSON serialization omits undefined object keys | Reject unintended undefined at the persistence boundary. Preserve SQL NULL, JSON null, absent property and empty array/object semantics |
| JSON bigint | PGlite 0.5.8 JSON serializer converts bigint to JSON string; normal `JSON.stringify` used by `pg` throws | Validate canonical JSON values before either adapter; do not silently accept engine-specific coercion |
| SQL bigint/identity | PGlite 0.5.8 returns number inside the safe JS range and bigint outside; installed `pg-types` returns INT8 as string | Choose one explicit representation. Existing public revision/counter numbers need checked conversion and range rejection; do not expose accidental bigint to JSON APIs |
| DML counts | Kysely expects `numAffectedRows` as bigint; stores consume `numUpdatedRows` | Adapt PGlite `affectedRows`/command result explicitly; preserve zero and one-row distinctions and `RETURNING` behavior |
| Boolean | SQLite helper converts boolean to 0/1; stores also explicitly write 0/1 (`plan/store.ts:66`, `attempt/store.ts:37`) | Use SQL boolean and JS boolean consistently; update equality/read conversions rather than accepting both forever |
| Instant | Public models use strings; Session/Attempt readers currently return stored strings unchanged; `pg` and PGlite default timestamp parsers produce `Date` | Define one UTC ISO millisecond boundary, using shared conversion or configured parsers. Preserve nullability; retain exact original strings where included in historical digests |
| Exact text | Sources, identifiers, authored reason text and existing digests have existing contracts | Keep text byte-for-byte where required; a timestamp or JSONB conversion must not rewrite canonical evidence |

PGlite parser findings come from installed `dist/chunk-2BOC2OMW.js.map`, original `src/types.ts:90–156`; `pg` findings come from installed `pg/lib/utils.js:45–82` and `pg-types/lib/textParsers.js:167–203`. Official documentation also describes JSON, date and query-parameter behavior. [node-postgres types](https://node-postgres.com/features/types), [node-postgres queries](https://node-postgres.com/features/queries)

`jsonb` does not retain whitespace, object key order or duplicate object keys; it also imposes PostgreSQL numeric/Unicode constraints. Array order remains meaningful; JSONB containment is not ordered-array equality. Preserve existing digests rather than hashing PostgreSQL's JSONB textual output. `plan/children.ts:276,342,451–455` still uses raw `JSON.stringify` for hashes/sorting, so round-tripping JSONB may change ordering-dependent behavior even where other helpers use canonical sorted-key serialization. The import review must identify each digest's actual preimage and establish stable reconstruction or retained text before converting its input. [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html)

`SnapshotStore.findEquivalent` compares the entire ordered `fact_ids_json` value (`snapshot/store.ts:64–75`), backed by a composite unique constraint (`sqlite-schema.ts:262`). This is equality/deduplication, not a GIN containment query. Keep ordered equality or introduce a bounded digest key with collision verification only after reviewing import identity preservation and index entry sizes. `procedure/store.ts:83–95` currently loads compiled JSON and searches it in application code: JSONB alone does not accelerate this query. Add GIN only if a chosen SQL query uses supported operators and measured plans justify its write/storage cost. B-tree matches the observed identity, revision, time-range and keyset-pagination predicates. [PostgreSQL index types](https://www.postgresql.org/docs/current/indexes-types.html)

## Proposed target architecture

1. Keep one internal `TrustDatabase` shape, one set of stores and domain services, and one shared PostgreSQL schema/preparation definition. Persistence row types may differ from public contracts; derive public models through explicit codecs. The SDK must not import server/driver implementation.
2. PostgreSQL adapter: Kysely PostgreSQL SQL compiler/adapter plus `pg.Pool`; acquire one client for the complete transaction; release after commit/rollback. Configure session settings and parsers per adapter, not by mutating global pg parsers used by unrelated extensions. Bound pool and query/lock timeouts; sanitize diagnostics. [node-postgres transactions](https://node-postgres.com/features/transactions)
3. PGlite adapter: same SQL compilation, local directory or disposable memory instance, and a narrow Kysely driver. Advertise `supportsMultipleConnections = false` for Kysely 0.29.5 so the existing connection mutex covers the entire transaction. Never allow unrelated statements to join another caller's transaction. Normalize result rows/counts with the same codec contract; ensure rollback restores availability and shutdown awaits persistence.
4. Use one shared, explicit prepare/upgrade path with version/checksum metadata and transactional PostgreSQL DDL. The first cut needs a controlled schema version and importer, not a generic multi-backend migration framework. Existing unknown schemas are refused, not repaired or dropped. Concurrent server preparation needs a database-level serialization point; embedded ownership needs a single runtime per data directory.
5. Domain locking, conflict handling and codecs belong in common persistence/runtime code, not separate PostgreSQL/PGlite business implementations. Only connection acquisition, transaction scheduling, result conversion and lifecycle differ.

The mobile extension demonstrates one shared `schema.sql`, explicit preparation and `pg` client pinning (`extensions/mobile-companion/postgres-db.mjs:42–60`, `server.mjs:1298–1347`). It is a useful precedent, not the core's persistence authority. Its loopback-only URL policy, fixed pool size, notification channel and standalone raw-query wrapper must not silently become the core's public configuration contract.

PGlite is one exclusive embedded database connection. Multiple callers may be queued, but this cannot prove multi-session lock contention, deadlock handling or MVCC behavior on a server. Node FS is supported; browser IndexedDB and its durability tradeoffs are separate deployment modes. Avoid relaxed durability by default for retained governance history. PGlite `dumpDataDir` is intended for PGlite restoration, not interchangeable PostgreSQL-server physical backup. A logical transfer is required when changing engine deployment. [PGlite getting started](https://pglite.dev/docs/), [PGlite filesystems](https://pglite.dev/docs/filesystems), [PGlite API](https://pglite.dev/docs/api)

## Entry points and packaging impact

| Surface | Verified location | Required future work |
| --- | --- | --- |
| Direct runtime process | `packages/trust-runtime/src/index.ts:28–52` | Replace `TRUST_DATABASE_PATH` SQLite assumption with explicit embedded/server selection; validate ambiguous configuration |
| Runtime/server API | `packages/trust-runtime/src/runtime.ts:85–129`, `server.ts:14,61–86` | Retain injected database support; initialize async adapter before services; define owned versus externally supplied disposal |
| Shared server shell | `packages/trust-shell/src/server.ts:111–124` | Currently overwrites database path with `stateDirectory/runtime.sqlite`; expose the selected backend and preserve per-instance state identity |
| Desktop distribution | `apps/trust-desktop` using the common shell | Route through the same selection/preparation implementation; package PGlite WASM/data assets and verify packaged startup/shutdown |
| Acceptance process helper | `packages/trust-runtime/acceptance/support/runtime-process.ts:20–39` | Parameterize disposable PGlite and real PostgreSQL; do not point tests at retained/shared runtime |
| Schema preflight and operational scripts | `database/sqlite-schema.ts:405–414` and callers to inventory during implementation | Keep SQLite preflight/import explicit; avoid interpreting a retained `.sqlite` filename as a new PGlite directory |
| Catalog and live views | `operation/catalog.ts`, `plan/events.ts` | Decide one-runtime shared deployment versus independent runtimes before promising cross-process coherence |

Cold startup, resident memory, import throughput, Fact batch throughput, Plan view latency, lock waits and history pagination are relevant measurements. None was measured in this study. Do not infer a performance gain from JSONB or PostgreSQL branding. WASM asset distribution and asynchronous startup change deployment even when application SQL is shared.

## Public acceptance plan (not executed)

All behavioral evidence must go through the real runtime process and its RPC/MCP/OTLP/Runner boundaries. Existing acceptance tests are useful source material; no unit tests are proposed.

| Journey | PGlite | PostgreSQL server | Existing source / added coverage |
| --- | --- | --- | --- |
| Published definitions, engagement, declarations, pinning and restart persistence | Required | Required | Existing backend/Plan journeys; identical and conflicting publication/engagement replay |
| Canonical scalar and JSON round-trip | Required | Required | Objects/arrays/scalars, null/absence, Unicode, booleans, instants, large numeric boundary; compare public values and historical identities |
| Full Produced-schema rejection and replay | Required | Required | `runtime-invariants.acceptance.test.ts:817`; no Fact/Snapshot/revision leak; retry from observed result without repeating action |
| Same-key concurrent admission and same-Attempt finalization | Queue behavior | Independent sessions | `runtime-invariants.acceptance.test.ts:911`; assert one admission identity and stable finalization |
| Concurrent ingestion/finalization/interruption | Required | Independent sessions | `runtime-invariants.acceptance.test.ts:962`; plus distinct Attempts sharing Facts and reversed lock paths |
| Intent reservation versus declarations/escalation | Required | Independent sessions | `runtime-invariants.acceptance.test.ts:210`, `plan-dry-run.acceptance.test.ts:631,1288`; no stale intent ownership |
| Two independent Checks finalize in one Plan | Required | Independent sessions | Conflict classification/re-evaluation; no lost qualification, duplicate revision or partial delta |
| Session close/expiry/renewal versus admission and ingestion | Required | Independent sessions | One open Session, defined winner ordering, no accepted batch against a wrongly stale Session |
| Parent re-observation/child supersession versus child admission/finalization | Required | Independent sessions | Pinned composition, active generation and ancestor escalation remain authoritative |
| Rollback and next-request recovery after database error | Required | Required | Constraint failure, interrupted connection, timeout; no externally repeated action as an automatic DB retry |
| Import into copies, restart, compare public history and continue the same Plan | Required | Required | Coordinator-owned migration acceptance; preserve identifiers/digests and reset sequences above imported maxima |
| Shared-reader consistency and live invalidation | One owner | Scope-dependent | If multiple runtimes are supported, independent processes sharing server DB; verify reread/invalidation and catalog visibility |
| Packaged shell/desktop lifecycle | Required | Required | Clean start/stop/reopen, preparation refusal, missing/ambiguous configuration, correct instance selection |

Concurrent HTTP requests against a single embedded connection are not PostgreSQL concurrency evidence. The server lane must actually permit overlapping transactions on distinct sessions, with repeatable controlled interleavings where possible. Builds/typechecks and the full Code Moniker gate qualify implementation structure; they do not establish these behaviors.

## Future lot boundaries and decisions

Suggested dependency order: (1) settle schema/codec and deployment decisions from this study; (2) common DDL/preparation plus narrow adapters; (3) common store codecs and concurrency controls; (4) explicit importer and copy validation; (5) entrypoint/packaging activation plumbing; (6) public acceptance matrix and controlled retained-data cutover. Adapter and schema work can be separately owned; `database.ts` and affected stores need one coordinated owner at a time. No worker should begin implementation before the study is returned.

Mechanical work includes dialect construction, explicit JSON encoding, row conversion, boolean storage, driver lifecycle and translating PostgreSQL-compatible FK/UNIQUE/CHECK definitions. Decisions still requiring explicit design treatment include the supported PostgreSQL baseline; one runtime versus independent runtimes; composition-wide lock strategy versus Serializable retry; preserved timestamp/digest preimages; numeric limits; snapshot equivalence indexing; and any new database-level immutability restriction beyond existing public behavior. PostgreSQL schema tightening must not silently forbid legitimate dry-run deletion or change imported identity semantics.

The safe cutover boundary is a reviewable implementation validated on copies. This mission did not back up, convert, reset, replace or restart any retained database. Backup validation, rollback limits after accepting new target writes, and the exact live activation decision belong to the coordinator's import report.
