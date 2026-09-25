# Core storage migration: impact study

Date: 2026-09-25. Baseline: `main`, commit `9dce1a2b22634c91bfd63ea3183840045bf9398d`.
Status: study for owner review; no core migration implemented or activated.

The approved direction is PostgreSQL as the SQL reference, PGlite for autonomous
embedded use, and PostgreSQL server for shared/concurrent use. One persistence
model and one PostgreSQL schema should serve both. SQLite remains an import source,
not a third supported runtime backend. Bidirectional synchronization and changing
every extension's storage are outside this work.

The owner's subsequent request puts this impact study before implementation.
Column conversions, stronger invariants and rollout details below are proposals,
not additional approved product decisions. This synthesis distinguishes the
recommended final design from concessions that may be needed during import.

## Recommendation and principal findings

The recommended final design uses JSONB for semantic documents, real booleans,
typed runtime instants, verified UUID identities, stronger relational invariants
and shared transaction discipline. Exact authored source and historical identity
inputs retain their original representation. Fix incidental dependencies on JSON
key order instead of making them permanent storage requirements. A blanket type
cast is unsafe, but a coordinated semantic conversion is the preferred outcome.

Three migration hazards are already visible in the executable code:

1. `plan/children.ts:276-295,454-455` hashes `JSON.stringify` of child inputs and
   compares it with the retained `input_digest`. Reordered object keys can
   supersede a child and create another generation. Canonicalizing future hashes
   alone does not preserve old hashes. This must be settled before converting the
   participating JSON columns.
2. `plan/runtime.ts:1708-1740` includes the original `observedAt` string in Fact
   identity. `fact/store.ts:33-38` compares reconstructed Facts, including receipt
   time. Converting those values to an equivalent instant is not necessarily an
   identity-preserving conversion.
3. SQLite's single Kysely connection currently serializes transactions. PostgreSQL
   exposes conflicting Plan/Attempt lock order, shared Fact insert races and
   check-then-create races. A dialect replacement is not behavioral parity.

Detailed inventories and verified consumer references are in the two companion
reports:

- [Schema, column types, constraints and serialization](storage-schema-impact-2026-09-25.md).
- [Transactions, drivers, deployment and public acceptance](storage-concurrency-impact-2026-09-25.md).

## Recommended final schema versus import transition

The detailed schema report's five text exceptions describe a conservative first
pass, **not the recommended destination**. They must not become permanent merely
because SQLite stored everything as strings. Prefer completing the semantic work
before live activation; use a temporary text stage only if it has an explicit
conversion exit criterion and the same schema on both target engines.

| Category | Recommended final design | Transition treatment |
| --- | --- | --- |
| All 18 JSON document/list columns | JSONB with verified shallow shape checks and typed persistence codecs; preserve array order/multiplicity | The five identified order-sensitive columns, and any inputs feeding them, may remain exact text in an intermediate import stage only until the semantic comparison/backfill below is proven. |
| Authored sources, opaque values, names, versions, URIs, existing digests | Exact `text` | Preserve verbatim throughout; these are legitimate final text fields. |
| Three boolean flags | `boolean NOT NULL` | Convert 0/1 after preflight and change all predicates/codecs atomically. |
| Runtime-generated timestamps | `timestamptz(3)` with stable UTC millisecond public output | Verify all historical values; no implicit server-local timezone conversion. |
| External observation/receipt timestamp spelling | Exact text remains authoritative for existing identity/replay | A typed projection is justified only by an actual query need; it cannot replace the original value. |
| Internally generated UUID identities | `uuid`, keeping the existing public string contract | Full inventory must prove compatibility; slugs/digests/Attempt keys remain text. |
| Counters and generated order | `bigint` with explicit safe-number bounds where the public contract uses numbers; bigint for internal generated positions | Preserve values and sequence high-water marks; reject lossy decoding. |
| Status and relational integrity | Named CHECKs, existing partial UNIQUEs/FKs, additional update immutability/state pairing and correctly correlated FKs | Validate every proposed constraint on copies, preserving dry-run deletion and cross-revision Snapshot reuse. No database enum expansion is needed. |

The clean transition for the five exceptions is concrete:

1. **Pinned composition:** compare semantic structure and the existing definition
   digest, while comparing authored source strings exactly. JSON key order and
   whitespace outside string values should not decide whether a composition is
   pinned. Preserve the original serialized document in the import archive; the
   executable representation can be JSONB without keeping a second live model.
2. **Child inputs and imported Results:** use one explicit semantic canonicalizer
   for object equality, Result ordering and change fingerprints. Preserve array
   order and every existing child ID/generation. Do not simply start comparing a
   new canonical digest against the old order-sensitive `input_digest`.
   Preserve that old digest as immutable provenance and backfill a distinct
   canonical comparison fingerprint from the verified original signature for
   each active generation. Validate the reconstructed legacy signature against
   its stored digest before backfill; refuse an ambiguous reconstruction. New
   generations and all runtime comparisons use the canonical fingerprint. This
   separates historical provenance from semantic change detection, with one
   runtime path and no SQLite compatibility adapter. Superseded history is not
   regenerated. The exact column naming is an implementation detail.
3. **Snapshot Fact lists:** store JSONB arrays with ordered equality, never
   containment. Replace a potentially unbounded composite unique index with a
   bounded canonical equivalence fingerprint and an exact tuple/list comparison
   on collision. Concurrent insertion must use that same collision-checked
   transaction path. Existing Snapshot IDs stay unchanged; this index key is
   not a replacement identity. No new membership table is justified by the
   present queries.
4. **Checklist delta and other replay comparisons:** compare typed semantic
   objects with ordered arrays instead of raw `JSON.stringify` byte order.
   Sources inside those objects remain exact string values. Existing identity
   hashes are preserved and checked through their original canonicalizers.

These are ordinary engineering changes to preserve the intended semantics while
improving representation. They do not require a separate product vote for each
column. What does require an explicit decision is any proposed narrowing of
currently accepted data, as distinguished below. Until the above backfill and
imported next-revision/replay journeys pass, broad JSONB conversion remains
unvalidated, not rejected as a design direction.

## Observed retained state

Read-only SQLite connections with a read transaction were used for each database.
These are two independent observations, not a cross-runtime atomic snapshot.
Both returned `integrity_check = ok`, zero foreign-key violations and schema digest
`1024543f31ed0d051c410821b99a1c3cefa65ee8f1d630865d1b27eee13fe781`.
Live work can change these counts; repeat the inventory at cutover.

| Table | Project 4498 | Mobile core 4318 |
| --- | ---: | ---: |
| `source_templates` | 1 | 0 |
| `registry_sources` | 0 | 0 |
| `environments` | 4 | 2 |
| `environment_variables` | 8 | 4 |
| `environment_credentials` | 0 | 0 |
| `published_procedures` | 26 | 2 |
| `catalog_metadata_revisions` | 0 | 0 |
| `plans` | 65 | 18 |
| `plan_revisions` | 291 | 55 |
| `child_generations` | 37 | 13 |
| `compiled_checks` | 911 | 54 |
| `sessions` | 65 | 18 |
| `attempts` | 128 | 18 |
| `facts` | 121 | 18 |
| `attempt_fact_receipts` | 121 | 18 |
| `check_snapshots` | 121 | 18 |
| `active_check_qualifications` | 432 | 19 |
| `plan_escalations` | 3 | 0 |
| `trust_schema` | 1 | 1 |

There are 18 typed application tables plus `trust_schema`; SQLite's internal
`sqlite_sequence` is separate. Its retained project Attempt high-water mark was
128. The project main SQLite file was 46,739,456 bytes, excluding WAL/SHM.

Every non-null `*_json` value passed SQLite `json_valid`; a literal escaped
`\u0000` scan found none. This is not a complete PostgreSQL Unicode, duplicate-key
or numeric-range preflight. Project Fact observation and receipt timestamps all
matched the UTC millisecond spelling pattern at inspection, but the public input
contract accepts more spellings; existing samples do not justify narrowing it.

Two results directly reject tempting new foreign keys:

- All 432 project active qualifications reference a Snapshot from a different
  Plan revision. A same-revision Snapshot FK would reject current valid data.
- 30 project Plans have no matching reusable published Procedure identity.
  Inline/pinned Plan history cannot be forced to reference the live catalog.

Sources were `.trust/project/runtime.sqlite` and
`~/Library/Application Support/TRUST/mobile-preview/state/runtime.sqlite`.
The mobile extension database on 15439 is a separate authority and was not read or
changed for this inventory.

## Conversion safeguards

| Value category | Proposed storage | Required preservation / impact |
| --- | --- | --- |
| Source Gherkin, template body, explanations, metadata prose | `text` | Preserve exact string, line breaks and source names. No recompilation or formatting during import. |
| Semantic JSON maps and arrays | `jsonb`, selectively | Explicit encode/decode contract; validate root shape and nullability; preserve array order and duplicates. Audit nested identity consumers first. |
| Pinned serialized artifacts and order-sensitive identity inputs | JSONB target; exact text only as a bounded transition/archive | Apply the semantic comparison and canonical-fingerprint backfill above. No generic legacy backend or duplicated mutable model. |
| Boolean flags (`deleted`, `intent_chaining`, `reobserve`) | `boolean` | Replace 0/1 row types, predicates and writes together; public booleans already have their own contract. |
| Runtime-generated instants | Candidate `timestamptz(3)` | Normalize outward to identical UTC ISO strings, verify ranges/precision and pagination. Preserve observation/receipt identity strings separately as described above. |
| Slugs, semantic URIs, names, versions, digests, invocation identities | `text` | No UUID coercion; exact version selectors and digest algorithms remain unchanged. |
| Internally generated UUID identities | Candidate `uuid` after inventory | Prove every historic value and FK counterpart qualifies; preserve public string spelling and identity. A column ending in `_id` is insufficient evidence. |
| Revision/order counters | `bigint` / generated identity with checked decoding | Preserve explicit historical values and sequence high-water marks; enforce public safe-number bounds. |
| Finite states | `text` plus named `CHECK` constraints initially | Keep values/transitions canonical; PostgreSQL enums/domains offer no demonstrated benefit here yet. |

PostgreSQL JSONB loses object-key order, whitespace and duplicate keys; SQL NULL
and JSON null remain distinct. It also imposes Unicode and numeric constraints.
These are documented engine properties, not newly measured TRUST failures.
([PostgreSQL JSON types](https://www.postgresql.org/docs/18/datatype-json.html))
Use equality, not JSONB containment, for ordered-list equivalence. Never use
`jsonb::text` as a replacement for an existing TRUST canonical digest algorithm.

Default JSONB decoding affects all string-based `JSON.parse` readers. Conversely,
the `pg` driver treats JS arrays as PostgreSQL arrays, so directly passing every
former JSON string as a JS object/array is unsafe. A common explicit parameter
encoder and typed row decoder should sit in the persistence layer; transport and
SDK types remain owned by their current packages.

No GIN index is justified merely because a column becomes JSONB. Current stores
mostly fetch whole documents and filter relational keys. Start with existing
uniqueness and measured B-tree access paths; inspect query plans on realistic
copied data before adding JSON expression or GIN indexes. A large
`(check_uri, compiled_digest, fact_ids_json)` unique B-tree key needs size analysis;
the observed project maxima (218 URI characters, 68 Fact-list characters) do not
establish a safe product-wide upper bound.

Ordering deserves its own compatibility check. PostgreSQL collation may differ
from SQLite text order; cursor queries use timestamp and identifier tie-breakers.
Choose deterministic collation for technical identities and exercise non-ASCII
inputs rather than relying on the server's locale default.
([PostgreSQL collations](https://www.postgresql.org/docs/18/collation.html))

## Persistence and deployment architecture

Keep Kysely stores and the domain shared. The database provider remains one
Awilix singleton, with explicit awaited initialization and disposal; see
`packages/trust-runtime/src/runtime.ts:108-165`. Two narrow adapters own connection
acquisition, transaction binding, result normalization and lifecycle. Neither
adapter owns Plan qualification or a second domain model.

One versioned PostgreSQL DDL source should serve both engines, including indexes,
constraints and PL/pgSQL equivalents of required triggers. Add narrowly scoped
schema version/checksum steps and an explicit SQLite import command. This follows
the newly accepted common-migration direction; it does not introduce a generic
product migration framework or silent database conversion at startup. Unknown
schemas, occupied targets and unsupported data must produce an actionable refusal.

The mobile companion demonstrates a shared SQL file plus separate PGlite/Postgres
connections (`extensions/mobile-companion/server.mjs:1315-1332` and
`postgres-db.mjs`). Its schema, policy and code are an example, not the authority
for core persistence. Reuse established dependency versions deliberately, then
pin and verify an engine compatibility matrix. The locally installed PGlite
package is 0.5.8; core PostgreSQL server major selection remains a validation
choice, not a consequence of the study's PostgreSQL 17 coordination container.

PGlite is an embedded single-connection engine. Serialize full transactions and
enforce one owner of a persistent data directory. Its filesystem/export behavior
needs explicit lifecycle acceptance; a PostgreSQL server pool is where true
multi-session isolation and lock races must be proven.
([PGlite overview](https://pglite.dev/docs/about),
[PGlite API](https://pglite.dev/docs/api))

Change entrypoints together: runtime options and environment configuration, shell
`runtime.sqlite` path construction (`packages/trust-shell/src/server.ts:104-124`),
desktop deployment, test process helpers and the test manager SQLite preflight.
Expose an explicit storage selection; never fall back to a new empty database
when a URL is invalid or an old SQLite file is present. Keep credentials outside
URLs printed to logs or copied into Plan metadata.

PostgreSQL supports concurrent clients, but multiple TRUST runtime processes need
additional coherence. Environment and credential services cache data in Maps
(`environment/service.ts:13-43`, `credential/service.ts:7-39`); Plan events are
process-local. The Operation catalog is a directory plus in-memory entries
(`operation/catalog.ts:34-77`), not a SQL table. A shared SQL database alone does
not synchronize these surfaces. Decide whether the first deployment is one
runtime with concurrent clients or multiple runtime processes; do not imply
multi-host correctness from database connectivity.

## Conservative import and activation protocol (proposed, not executed)

### Inventory and backup

1. Identify the exact active runtime, launch configuration, SQLite path, semantic
   authority, Operation directory, extension installation file and external data
   roots. Import project and mobile core independently; do not merge identities
   or archive unrelated databases.
2. Make a uniquely named SQLite online backup through the supported backup API,
   never copy just a live main file and ignore WAL. Reopen the backup read-only;
   verify integrity, foreign keys, expected schema digest, all table counts and
   ordered row-content hashes. Preserve the existing 2026-09-18 backup and all
   newer retained snapshots. The prior one-off upgrade demonstrates this pattern
   in `packages/trust-runtime/scripts/upgrade-catalog-metadata.mjs:17-48`.
   ([Node SQLite backup](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options))
3. Preserve the exact Operation source files and a manifest of byte hashes. The
   project directory currently contains 46 `.feature` files. Published Procedures
   embed Operations, but that is not a complete backup of the reusable Operation
   catalog. Copy relevant private configuration with restricted permissions;
   do not put credentials into reports or Git.
4. Preflight each proposed conversion on the immutable backup: JSON root types,
   duplicate keys, Unicode/NUL, numeric precision/range, timestamp spellings,
   UUID format, integer bounds, orphan references and stronger constraints. Report
   table/key/column diagnostics without sensitive payloads. Reject unsupported
   rows; never silently sanitize or drop them.

### Import into a new, explicitly selected target

5. Require an absent PGlite directory or an explicitly provisioned empty
   PostgreSQL database/schema. Assert target identity and engine/version before
   writing. Run the same target DDL with a maintenance lock and recorded checksum.
   SQLite inspection stays a one-way tool dependency, absent from normal runtime
   startup.
6. Copy all application rows with their identifiers, revisions, intent state,
   timestamps, immutable sources, pinned definitions, Facts, receipts, Snapshots,
   active qualifications and escalations. Do not engage new Plans, recompile
   historical definitions, regenerate UUIDs, re-run actions or requalify history.
   `trust_schema` becomes target migration metadata; archive the source digest in
   the import manifest instead of pretending it is the PostgreSQL schema digest.
7. Load in FK order in one target transaction, or into an isolated unpublished
   staging target with an explicit final activation boundary: environments and
   catalog/templates; Plans; revisions; compiled Checks; child relations; Sessions;
   Attempts; Facts; receipts; Snapshots; active qualifications; escalations.
   Import escalations after historical Attempts/revisions so active-Plan admission
   triggers do not reject legitimate old history. Newly proposed cyclic FKs must
   be designed for deferred validation before implementation.
8. Preserve `plan_revisions.id` and `attempts.attempt_order`; set new sequence
   state above both the imported maximum and SQLite's retained AUTOINCREMENT
   high-water mark, including deleted values. A retry never overwrites an occupied
   successful target. Failed target state remains identifiable; the source remains
   unchanged.

### Compare and rehearse

9. Compare every row using two contracts: exact equality for source/identity and
   archived text, and declared semantic equality for approved type conversions.
   Compare every stored digest unchanged and exercise its original computation
   where applicable. Check JSON null versus SQL NULL, absent fields, empty arrays,
   array order, duplicate array members and safe numeric decoding. Counts alone
   are insufficient.
10. Start a copy-only runtime on a distinct transport port while retaining the
    source semantic authority for old Check URIs. Keep extension auto-start and
    action execution off unless explicitly required by a disposable acceptance.
    Read every retained Plan and every catalog page through RPC/MCP; compare
    pinned composition, current qualification, history, intent and declarations.
    Some Plan reads initialize intent chains: establish which comparisons are
    observational and compare any allowed initialization explicitly.
11. Execute public acceptance journeys on disposable copies for both engines;
    exercise real server sessions for conflicts. Verify restart persistence and
    restore each engine's backup into a separate target. A PostgreSQL dump is
    internally consistent, but PostgreSQL roles and external files need separate
    handling. Do not assume a physical PGlite directory can be mounted as a
    PostgreSQL server data directory.
    ([PostgreSQL backup/restore](https://www.postgresql.org/docs/18/backup-dump.html))

### Cutover and rollback boundary

12. After review and successful rehearsals, schedule the named runtime's write
    pause. Stop new admissions, resolve or explicitly account for in-flight
    Attempts/OTLP delivery, stop its writer, take and verify a final backup plus
    Operation manifest, and import that final snapshot. An earlier online backup
    is not a cutover snapshot while the source continues changing.
13. Activate by changing the named runtime's storage configuration, preserving
    semantic authority, endpoint and Operation files. Perform read/health checks
    before admitting new work. Keep the untouched SQLite files and the exact old
    executable/configuration available; do not run both as active authorities.
14. Before new target writes, rollback can restore the old configuration and
    executable against its untouched source. After new writes or external actions,
    switching back loses divergent history and is not safe rollback: stop, preserve
    both states and make an explicit recovery decision. No reverse synchronization
    or automatic repeated external action is implied by this project.

## The three owner-level decisions

These are the product/deployment boundaries to settle; adapter details, column
names, shared codecs, canonical comparison, index implementation and lock order
are engineering responsibilities within those boundaries.

| Decision | Recommendation | Consequence |
| --- | --- | --- |
| Shared deployment scope | Deliver one runtime with concurrent clients first; include multiple independent runtimes now only if that is required | Multi-runtime service coherence requires catalog, configuration-cache and notification work, beyond SQL concurrency. |
| Supported value domain | Preserve existing valid business values and public representations; introduce no silent sanitation | If full preflight finds values PostgreSQL cannot represent (for example NUL), the owner chooses an explicit representation policy or deliberate restriction. This is conditional on evidence, not a request to approve every scalar type. |
| Activation target and window | Validate both backends on copies, then activate one named retained runtime during a defined write pause | Select project/mobile core and embedded/server deployment; account for in-flight actions and the point beyond which rollback would discard new history. |

Recommended engineering defaults are JSONB semantic comparison with exact source
strings, immutable historical IDs/digests plus derived canonical change
fingerprints, one composition-root-first lock order followed by Attempt locks,
database-only conflict handling and bounded index keys with exact collision
verification. Retain the approved dry-run removal behavior; blanket history
deletion bans are outside scope. Validate these defaults through the public
journeys and adjust implementation from evidence, without turning routine design
choices into repeated approval gates.

## Proposed implementation lots and dependencies

| Lot | Scope | Depends on | Required evidence |
| --- | --- | --- | --- |
| 0 — study review | Confirm product/deployment boundaries; record recommended schema and engineering defaults | This study | Clear shared-runtime/value-domain/activation scope |
| 1 — common storage foundation | PostgreSQL DDL, typed rows/codecs, PGlite and server adapters, initialization/disposal | 0 | Public startup, read/write, rollback and restart journeys on both engines |
| 2 — transaction correctness | Plan/Attempt lock ordering, dedup and publication races, revision conflicts, child cascades | 1 | Two real PostgreSQL sessions/processes; no duplicate or partial results |
| 3 — conservative import | Read-only SQLite reader, backup/manifest, target validation, lossless import and comparison | 1 plus agreed identity policy | Full retained-copy comparison on both targets; malformed input and refusal journeys |
| 4 — entrypoints and packaging | Runtime, shell, Electron, runner deployment assets, test harness and docs | 1–3 | Installed entrypoint and packaged PGlite assets; precise bad-config refusal |
| 5 — activation | Final snapshot, controlled change of selected live runtime, retained-data rereads | All gates and named activation decision | Distinct implemented / validated / activated evidence |

No unit tests are proposed. The companion concurrency report defines the public
acceptance matrix. Builds/typechecks qualify packaging/types; they do not prove
behavior. Run the full Code Moniker gate after implementation, preserve the SDK
boundary, and align the A3 functional model only after an approved implementation
milestone. This study does not change the product grammar or approve its proposals.

## Study execution and coordination evidence

The existing project runtime 4498 had no extension installed. The mobile runtime
4318 had only `mobile-companion`; nothing listened on the old coordination port
15432. Neither existing runtime was restarted or modified for this study.

A dedicated instance uses runtime 4510, web 4180, PostgreSQL 15440, container and
volume `trust-storage-study-20260925`, and private local state under
`.trust/storage-study-20260925/`. The extension was prepared and started through
its public lifecycle. Four exact Operations and `agent-delegation@1.0.0` were
published only in that study instance.

The two missions were persisted through their `create mission` Runner Checks,
each returning `COMPLETED` and `VALIDATED`, before host dispatch. Both workers then
claimed their own missions through the Runner with the same explicit result:

- [Schema mission](http://127.0.0.1:4180/extensions/coordination?coord.mission=storage-impact-schema-20260925).
- [Concurrency mission](http://127.0.0.1:4180/extensions/coordination?coord.mission=storage-impact-concurrency-20260925).

The board/API returned HTTP 200. The browser rendered both assigned cards with
their live Plan intentions and qualified Check counts. Extension state was
`RUNNING`. Host dispatch was
to `storage_schema_analyst` and `storage_concurrency_analyst` in this task's shared
main checkout. These are study missions; no earlier implementation Plan was
engaged or silently repurposed. Runner results are retained in the private study
directory. After independent source/report review, both analyst responses were
submitted and both coordinator `observe completion` Checks returned `COMPLETED`
and `VALIDATED`. Final public Plan reads show **COMPLETE, revision 6, 4/4 Checks**
for each mission. The schema Plan's final qualified Check was also visible in the
browser. The coordinator's review clarifications in this synthesis and the
annexes distinguish the target schema from the analysts' import concessions;
the original persisted worker responses remain unchanged. A completed mission
means a persisted analyst response; it does not approve migration or prove that
the proposed implementation works.

The full `code-moniker check . --report --format json` baseline scanned 666 files;
the final check with the three reports scanned 669 files, with zero violations,
rule errors or analysis errors. That is structural evidence, not migration
acceptance. No unit tests, behavioral migration tests, build,
import, live activation, commit, push or package publication was performed for
this documentation-only study. Existing untracked quiz files were preserved.
