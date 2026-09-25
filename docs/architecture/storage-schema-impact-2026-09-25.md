# Core storage schema impact study — 2026-09-25

Status: analysis and proposals only. No functional implementation, database migration,
runtime activation or acceptance test was performed by this schema study.

Coordinator review: the text exceptions below are **transition safeguards**, not
the recommended final schema. The [consolidated target design](storage-impact-2026-09-25.md#recommended-final-schema-versus-import-transition)
recommends JSONB for all semantic documents after replacing incidental key-order
dependencies, with an explicit canonical-fingerprint backfill preserving old
identities and digest provenance. Its three owner-level boundaries distinguish
product/deployment decisions from ordinary implementation choices.

The approved direction is PostgreSQL reference SQL, PGlite for autonomous embedded
use and PostgreSQL server for shared concurrent use. It does not approve every type
or constraint proposed below, change extension storage ownership, or introduce
bidirectional synchronization.

TRUST tracking: Plan `storage-impact-schema-20260925`, assignee
`storage_schema_analyst`, dedicated runtime `http://127.0.0.1:4510`. Claim returned
`COMPLETED` and `VALIDATED`, attempt `1c8a80ae-96f6-4426-b5ca-648fc36215fb`.
The coordinator owns the consolidated impact study, retained-data inventory and
import/rollback plan. This document owns the column and schema analysis.

## Evidence and scope

The current schema is
[`sqlite-schema.ts`](../../packages/trust-runtime/src/database/sqlite-schema.ts)
(table definitions at lines 6–337, schema metadata at 344–349). There are **19
application tables: 18 typed runtime tables and `trust_schema`**. SQLite's own
`sqlite_sequence` is an implementation artifact, not a twentieth business table.
[`database.ts`](../../packages/trust-runtime/src/database/database.ts):5–233 declares
the 18 persistence interfaces and `Database = Kysely<TrustDatabase>`.

The inspected checkout was `main`, ahead of its upstream by nine commits, with
pre-existing untracked quiz artifacts. Those files were not changed. References
below use the source lines inspected on this date; future edits may move them.

Code Moniker was used as the structural analyzer. The CLI's `rules learn basics`,
`taxonomy`, `profiles` and `refs` topics were read, followed by the full project
corpus and `rules show . --profile canonical-contracts --details`. The project
corpus reported 30 distinct rules and 238 compiled rows. `stats .` inspected 666
files. The initially stale daemon was refreshed through
`symbol.graph ... consistency:refresh-if-stale`, without restarting a service.
The refreshed `symbol.graph` for `packages/trust-runtime/src/database/database.ts`
reported **48/48 incoming symbol groups**, principally `uses_type`, and 19/19
internal edges; the displayed member list was bounded at 80/191. Generation 3
confirmed that set. Consumers include Attempt, Fact, Plan, Session, Snapshot,
Escalation, Procedure, Registry, Credential and Environment stores, child
composition, runtime construction, catalog metadata and templates. This is
type-dependency evidence, not 48 distinct modules or proof of SQL behavior.
An exact `symbol.usages` query for `fact/store.ts`'s `canonicalJson` returned its
two calls in `append` and one recursive callback call. Direct source reads then
established the persistence semantics below.

## Recommended target boundaries

Keep one PostgreSQL schema and persistence model inside the runtime. Connection
acquisition, transaction ownership, result decoding and shutdown differ between
the PGlite and PostgreSQL adapters; business stores and qualification remain
common. Keep canonical domain types in their current owner packages. The internal
`database.ts` projection must change with SQL types, rather than letting SQL row
objects leak into the SDK or duplicating the domain types.

The mobile extension demonstrates a narrow PostgreSQL transaction adapter at
[`postgres-db.mjs`](../../extensions/mobile-companion/postgres-db.mjs):42–60 and
PGlite/PostgreSQL selection at
[`server.mjs`](../../extensions/mobile-companion/server.mjs):1298–1332. This is
useful precedent, not the core persistence authority. Its loopback-only deployment
configuration and notification channel are extension-specific.

The existing SQLite adapter explicitly converts booleans to integers and rejects
objects (`sqlite.ts`:53–65). Stores stringify JSON on write and parse it on read.
Changing the dialect without changing these boundaries is insufficient.
PostgreSQL's Node driver returns JSON/JSONB as parsed values, UUID as strings and
timestamps as `Date` by default; a shared decoding policy is therefore required.
[node-postgres type documentation](https://node-postgres.com/features/types).
PGlite exposes per-type parsers and serializers and reports affected row counts;
the adapter must map those counts to Kysely's existing `bigint` result contract.
[PGlite API](https://pglite.dev/docs/api).

## Complete column inventory and proposed types

The inventory lists **every column**. Existing non-nullability, primary keys and
foreign keys are retained unless an explicit proposal says otherwise. `?` means
SQL nullable. All existing non-integer columns are SQLite `TEXT`; there are no
native SQLite JSON or datetime columns. `J` means a proposed `jsonb` document,
subject to the safety gates in the next section. `T` means proposed
`timestamptz(3)` with exact UTC ISO millisecond output and import preflight.
`N` means an integer counter: prefer PostgreSQL `bigint` with a checked safe-number
decoder and upper bound matching the public JavaScript number contract, rather
than silently narrowing SQLite's 64-bit integer range to PostgreSQL `integer`.
Generated surrogate values may remain internal `bigint`; keep their existing
values during import and advance their identity sequences past the imported max.
The choice of int4 versus int8 is an implementation decision requiring an actual
range inventory, not a blanket consequence of the migration.

| Table and schema lines | Columns and proposed target types | Consumer and preservation notes |
| --- | --- | --- |
| `source_templates`, 6–14 | `id text`; `deleted boolean`; `title text`; `description text`; `body text`; `parameters_json J` (array); `revision N >= 1` | `template/service.ts`:62–69, 78–159. IDs are user template identifiers. Body is editable source, preserved verbatim. Tombstones intentionally contain empty title/body and `[]`; do not add unconditional non-empty checks. Convert every `deleted = 0/1` predicate and write. |
| `registry_sources`, 16–24 | `name text`; `kind text CHECK git/http`; `url text`; `reference text?`; `created_at T`; `updated_at T` | `registry/store.ts`:45–88. Preserve `(kind = 'git') OR reference IS NULL`. Reference is a Git ref, not UUID. URL/text equality remains exact. |
| `environments`, 26–30 | `name text`; `created_at T`; `updated_at T` | `environment/store.ts`:32–54, 66–81. Named configuration with replace-all variables in one transaction. |
| `environment_variables`, 32–38 | `environment text`; `name text`; `value text`; `updated_at T` | `environment/store.ts`:12–29, 39–52. `(environment,name)` PK and environment cascade preserved. Values are opaque strings even when they look like JSON, booleans, URLs or numbers. |
| `environment_credentials`, 40–46 | `environment text`; `name text`; `value text`; `updated_at T` | `credential/store.ts`:12–35. Same composite PK/cascade. Opaque credential text must not be parsed, normalized, logged in an import report or indexed by content. Encryption policy is not changed by choosing PostgreSQL. |
| `published_procedures`, 48–59 | `procedure_name text`; `procedure_version text`; `definition_digest text`; `source_name text`; `source text`; `compiled_procedure_json J` (object); `published_by text`; `published_at T` | `procedure/store.ts`:18–59, 100–115. PK `(name,version)`, unique digest, immutable update/delete. Keep exact source and embedded source string. Version is SemVer, publisher is an opaque actor identifier, neither is UUID. |
| `catalog_metadata_revisions`, 61–71 | `kind text CHECK operation/procedure`; `name text`; `version text`; `revision N >= 1`; `title text`; `description text?`; `classification_json J` (object); `updated_at T` | `catalog/metadata.ts`:32–79, 82–141. PK `(kind,name,version,revision)`. Classification is a normalized mapping to arrays, not prose. SQL NULL description maps to absent public property. Revision 0 is the compiled base, not a persisted row. |
| `plans`, 85–106 | `plan_slug text`; `procedure_name text`; `procedure_version text`; `environment text`; `mode text CHECK live/dry-run`; `intent_chaining boolean`; `intent_chain_state text CHECK DISABLED/NOT_STARTED/ACTIVE/COMPLETE`; `current_intent text?`; `current_intent_check_uri text?`; `current_intent_attempt_key text?`; `metadata_json J` (object); `root_inputs_json J` (object); `current_revision N >= 1`; `created_at T` | `plan/store.ts`:29–123, 158–285, 289–314. Preserve immutable identity/environment/mode/metadata/roots and all four intent consistency branches. Slugs, Check URIs and attempt keys stay text. There is deliberately no unconditional catalog/environment FK proposal; see constraints. |
| `plan_revisions`, 108–123 | `resolved_procedure_json`: retain exact JSON **text for first cut** pending pinned-byte decision; `id bigint GENERATED ... AS IDENTITY`; `plan_slug text`; `revision N >= 1`; `definition_digest text`; `source text`; `declarations_json J` (object); `mission_declarations_json J` (object); `resolved_missions_json J` (object mapping collection names to arrays); `role_values_json`: retain JSON **text initially** pending order-sensitive composition work; `check_values_json J` (array); `invocations_json`: retain JSON **text initially** pending order-sensitive composition work; `compiled_at T` | `plan/store.ts`:81–97, 407–459 and SDK `index.ts`:447–454. Unique `(plan_slug,revision)`, generated internal ID preserved, Plan FK/cascade retained. `role_values_json` is an array OR a versioned object with produced/imported arrays, not one unconditional shape. Resolved/inline compositions are immutable history, not catalog entries. |
| `child_generations`, 125–137 | `parent_plan text`; `invocation_id text`; `generation N >= 1`; `child_plan text`; `input_digest text`; `observed_revision N` (propose `>= 1` after data check); `created_at T`; `superseded_at T?` | `plan/children.ts`:264–335. Composite PK and unique child Plan; partial unique current generation preserved. `child-${UUID}` is a slug, so never cast `child_plan` to UUID. Input digest is currently byte-order sensitive. |
| `compiled_checks`, 158–168 | `plan_slug text`; `plan_revision N >= 1`; `check_uri text`; `compiled_digest text`; `check_json J` (object, after composition-order audit) | `plan/store.ts`:99–111, 328–359. Keep PK, composite unique key and exact revision FK. URI is semantic text with hash-derived coordinates, not UUID. Do not remove the composite unique key while FKs refer to it. |
| `sessions`, 176–188 | `session_id uuid` (conditional full-data validation); `plan_slug text`; `state text CHECK open/closed/expired`; `opened_at T`; `expires_at T`; `closed_at T?` | `session/store.ts`:15–79; runtime UUID creation at `plan/runtime.ts`:243, 296, 1603. Preserve unique `(session_id,plan_slug)` and one-open-session partial index. Closed and expired semantics must be taken from actual callers, not assumed from column names. |
| `attempts`, 190–226 | `invocation_digest text?`; `attempt_order bigint GENERATED ... AS IDENTITY`; `attempt_handle uuid`; `attempt_key text`; `execution_id uuid`; `plan_slug text`; `plan_revision N >= 1`; `check_uri text`; `compiled_digest text`; `session_id uuid`; `operation text`; `operation_digest text`; `action_input_json J` (object); `environment text`; `reobserve boolean`; `intent text?`; `next_intent text?`; `state text CHECK pending/interrupted/finalized`; `admitted_at T`; `expires_at T`; `interrupted_at T?`; `finalized_at T?`; `finalization_json J?` (object or SQL NULL) | `attempt/store.ts`:20–65, 121–175; UUID generation at `plan/runtime.ts`:1487–1507. UUID proposals depend on validating every imported value. Attempt key is caller-controlled despite Runner default UUID generation. Preserve all uniques and composite Check/Session FKs. Ordering is generated admission order, not a gap-free counter. |
| `facts`, 228–237 | `fact_id text`; `check_uri text`; `compiled_digest text`; `fact_index N >= 0`; `operation text`; `operation_digest text`; `observed_at text` **retained exact**; `payload_json J` (object, after digest/Unicode validation) | `fact/store.ts`:30–76, 133–157 and `plan/runtime.ts`:1708–1741. ID is SHA-256 content identity, not UUID. Observed timestamp spelling is part of the hash. Do not add FK from Fact to removable Check/Attempt; retained Facts intentionally outlive removed Plans. |
| `attempt_fact_receipts`, 239–246 | `attempt_handle uuid`; `fact_id text`; `fact_index N >= 0`; `recorded_at text` **retained exact initially** | `fact/store.ts`:35–38, 66–74, 86–145. PK `(attempt_handle,fact_index)`, unique `(attempt_handle,fact_id)`, Attempt cascade and Fact FK retained. Recorded-at is externally supplied and participates in whole-Fact retry comparison; preserve lexical value. |
| `check_snapshots`, 248–279 | `snapshot_id text`; `attempt_handle uuid`; `plan_slug text`; `plan_revision N`; `check_uri text`; `compiled_digest text`; `state text CHECK open/satisfied`; `verdict text CHECK VALIDATED/NOT_VALIDATED`; `reason_code text`; `reason text`; `fact_ids_json`: retain ordered JSON **text initially**, or separately approve JSONB/normalized membership; `checklist_delta_json`: retain JSON **text initially** until key-order-sensitive replay comparison changes; `calculated_at T` | `snapshot/store.ts`:36–97, 192–221; `plan/runtime.ts`:1180–1204. Content-derived ID remains unchanged. Equivalent lookup and unique key depend on the ordered Fact list. Composite FK matches the originating Attempt/Check revision. |
| `active_check_qualifications`, 281–291 | `plan_slug text`; `plan_revision N`; `check_uri text`; `compiled_digest text`; `snapshot_id text`; `activation_digest text` | `snapshot/store.ts`:154–188; `plan/runtime.ts`:1170–1217. PK by current revision/Check. Snapshot can originate in an **older revision**. Proposed stronger snapshot correlation excludes revision; see below. Active qualification is replaceable through revisions, unlike immutable Snapshot history. |
| `plan_escalations`, 293–317 | `escalation_id uuid`; `plan_slug text`; `plan_revision N`; `snapshot_plan_revision N`; `check_uri text`; `compiled_digest text`; `snapshot_id text`; `attempt_handle uuid`; `blocking_reason text`; `forbidden_further_action text`; `escalated_at T`; `resumed_at T?`; `resume_reason text?` | `plan/escalation-store.ts`:15–83; `plan/runtime.ts`:438–450. UUID proposal conditional on data validation. Preserve both distinct revisions, resume field pairing, one active escalation per Plan and one escalation per Attempt. Escalation record may be updated only to resume through the existing operation. |
| `trust_schema`, 344–349 | `singleton smallint PRIMARY KEY CHECK = 1`; `digest text` | `sqlite-schema.ts`:340–440. This exact SQLite DDL digest remains import provenance. A common PostgreSQL bootstrap/version marker must identify its own SQL schema. Do not label a PostgreSQL database with the old SQLite schema digest or silently accept an unknown source schema. Version bookkeeping must remain a bounded protocol consistent with the repository's no-generic-migration-framework rule. |

## JSONB: semantic data versus byte-sensitive history

There are **18 JSON-bearing text columns**, all enumerated above. JSONB can enforce
valid JSON and support structured predicates, but it discards object key order,
duplicate keys and insignificant whitespace. It rejects escaped NUL and malformed
surrogate pairs; numeric and Unicode acceptance also differs from general JSON.
SQL NULL and JSON `null` remain different. Array storage preserves order, but
containment is not ordered-list equality. [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html).

The primary recommendation is JSONB for semantic documents, with **five explicit
first-cut exceptions**: `resolved_procedure_json`, `role_values_json`,
`invocations_json`, `fact_ids_json`, and `checklist_delta_json`. Retaining these
exact strings is a common PostgreSQL/PGlite schema choice, not continued SQLite
support. These exceptions can be removed by deliberately resolving the following
consumers, rather than by leaving a permanent dual model:

For a minimal first implementation, separate the unambiguous editorial data from
execution-history documents:

| Field family | Minimal first implementation | Completion criterion |
| --- | --- | --- |
| Template parameters and catalog classification | JSONB with array/object shape checks | Identical template rendering, tombstone/recreation, metadata revision behavior and public values. |
| Execution documents marked `J` above | Target JSONB, but convert only when the full composition/digest dependency gate passes; otherwise keep exact text in the common initial PostgreSQL schema | Public imported-Plan continuation, replay and next-revision evidence on both modes without synthetic identity/history changes. |
| Five explicit byte/order-sensitive exceptions | Keep exact text initially | A separate resolved design for pinned equality, child hashing, Snapshot list equivalence and retry comparisons before conversion. |
| Authored source, opaque strings, external Fact timestamps and all existing digests | Keep exact text | Source/digest/identifier equality and original timestamp spelling preserved through import and API reads. |

This allows useful tightening immediately without making broad historical JSONB
conversion a prerequisite for the engine change. It also keeps one target SQL
schema for both engines.

1. **Pinned composition equality is byte-sensitive in SQL.**
   `sqlite-schema.ts`:145–155 rejects a new revision if its serialized resolved
   Procedure differs from any prior revision. Replacing text equality with JSONB
   equality weakens that test to semantic JSON equality. Keeping exact text is the
   conservative initial mapping. Adopting semantic equality plus preserved exact
   authored sources is plausible, but must be named as a design decision and
   exercised through repeated revisions of an imported Plan.
2. **Child generation uses order-sensitive application hashing.**
   `plan/children.ts`:276–295 hashes `invocation.rootInputs` with
   `JSON.stringify` at 454–455 and supersedes a current child when it differs.
   JSONB-returned object order can change that digest after import despite equal
   business values. Lines 342 and 451 also hash/compare or sort imported Result
   objects with `JSON.stringify`. Moving only `invocations_json` back to text
   does not eliminate every risk: `root_inputs_json`, `check_values_json` and
   other documents can feed rebuilt revisions and imported Results. Before any
   composition-bearing document becomes JSONB, compare the **reconstructed
   composition and next revision**, not merely each stored JSON value. A new
   canonical hash algorithm cannot silently replace persisted `input_digest`;
   choose an explicit transition preserving current child identity and generation.
3. **Snapshot equivalence is an ordered-list contract.**
   `snapshot/store.ts`:64–75 compares serialized Fact IDs, and
   `sqlite-schema.ts`:262 makes that string part of a unique key. JSONB equality
   can represent ordered array equality, but `@>` cannot replace it. A normalized
   `snapshot_facts(snapshot_id,position,fact_id)` would add FK integrity and
   reverse Fact lookup, at the cost of another persisted relation and an explicit
   equivalent-list lookup strategy. No current reverse lookup requirement was
   found. Keep exact text initially; do not normalize simply because JSONB exists.
4. **Snapshot retry comparison depends on object key order.**
   `snapshot/store.ts`:192–204 compares `JSON.stringify(checklistDelta)`;
   reordering JSONB keys can report a false collision in that method. The main
   finalizer reuses an existing equivalent Snapshot at `plan/runtime.ts`:1202–1204,
   so do not claim every replay inevitably takes this collision path. Nonetheless
   the shared store contract must be corrected before conversion of this column.

Semantic JSONB candidates still require these guards:

- Keep `source`, template `body`, source names and source strings nested inside
  compiled or inline definitions unchanged. A compiler semantic digest is not
  proof of identical authored bytes: `procedure/store.ts`:25–33 separately checks
  source equality, and 100–108 checks persisted source consistency.
- Never recompute existing identifiers or digests by hashing `jsonb::text`.
  Runtime canonical hashing sorts object entries and preserves arrays
  (`plan/runtime.ts`:1770–1790); the Procedure compiler has its own canonical
  digest at `trust-procedure/src/compile.ts`:1488–1501. Database output formatting
  is not either canonicalizer. Preserve Fact, Snapshot, compiled, Operation,
  definition, activation and child-input digests verbatim.
- Preserve absent keys, JSON null, SQL NULL, empty object and empty array as
  distinct states. Do not apply `COALESCE(...,'{}')` to missing optional values.
  `role_values_json` explicitly supports both an array and a versioned envelope
  (`plan/store.ts`:433–459); an object-only CHECK would reject valid old rows.
- JSON.stringify/parse already limits most runtime data to JavaScript JSON
  semantics. Do not promise arbitrary precision: an imported number may be valid
  PostgreSQL numeric yet lose precision when decoded through JavaScript. Compare
  source and target canonical values and digest inputs before activation; reject
  lossy cases explicitly. Preserve original serialized input in the backup.
- Preflight every proposed JSONB value for invalid JSON, NUL, lone surrogates,
  duplicate keys and numbers outside the chosen representation. Duplicate-key
  detection must precede ordinary JSON.parse, which loses that evidence. A
  `json_valid` result alone does not prove JSONB compatibility. The coordinator's
  retained-database inventory is a useful baseline, not this full preflight.
- Add only shallow shape constraints with verified shapes, e.g.
  `jsonb_typeof(metadata_json) = 'object'`. Validate complete Fact Produced schemas
  at the existing application boundary; do not duplicate each Procedure's business
  rules in SQL. Empty arrays remain valid where the model allows them.

## Timestamps, booleans, identifiers and serialization

The three integer flags are `source_templates.deleted`, `plans.intent_chaining`
and `attempts.reobserve`. Convert them to SQL boolean and TypeScript boolean
throughout writes, predicates and reads. `row.reobserve === 1` in
`attempt/store.ts`:165 and intent predicates in `plan/store.ts`:168, 192, 242,
263, 280 must change; a type cast cannot correct their runtime behavior.

Use `timestamptz(3)` for runtime-produced instants only after checking stored values
round-trip to their existing `toISOString()` form. PostgreSQL represents an instant
and renders it according to the session time zone; it does not preserve the
original offset spelling. [PostgreSQL datetime documentation](https://www.postgresql.org/docs/current/datatype-datetime.html).
Both adapters must expose the current public string form, with identical precision
and ordering. `Date` versus string discrepancies break date consumers and cursor
comparisons (`plan/store.ts`:289–314, `snapshot/store.ts`:101–143).

**Keep `facts.observed_at` as text.** The runtime accepts any Date.parse-compatible
string and hashes its exact value into the Fact ID (`plan/runtime.ts`:1708–1739).
Two spellings for the same instant are not currently the same Fact. Normalizing
them would change identity. **Keep `attempt_fact_receipts.recorded_at` as text**
initially: input is validated with Date.parse at 964–973, and Fact retry comparison
at `fact/store.ts`:35–38 includes the reconstructed recordedAt string. Adding a
typed instant projection later is separate from replacing these original values.
Reject or separately handle PostgreSQL-incompatible text such as actual NUL;
never silently strip it from sources, credentials or payloads.

Only runtime-generated Session IDs, Attempt handles/execution IDs and escalation
IDs are UUID candidates. Fact and Snapshot IDs are SHA-256 hex, semantic Check
URIs contain derived coordinates, child Plan IDs have a `child-` prefix, and
Attempt keys remain caller strings (`trust-runner/src/check/run.ts`:61 allows an
injected generator). Preserve textual semantics for all these non-UUID identities.
Even a UUID candidate needs a full retained-data check and stable public lowercase
string output before import. Digest format CHECKs are optional tightening only
after confirming every current and historical format; retain `text` instead of
space-padding `char(n)` or converting to opaque binary for no demonstrated need.

## Constraints and triggers: preserve first, tighten deliberately

Preserve all existing PK, UNIQUE, NOT NULL, CHECK and FK constraints from the
inventory and the four explicit partial/unique indexes: current child generation,
one open Session, one active escalation and one escalation per Attempt.
PostgreSQL uniqueness is implemented using unique B-tree indexes, so do not
duplicate those indexes manually. [PostgreSQL unique indexes](https://www.postgresql.org/docs/current/indexes-unique.html).

Retain closed text status CHECKs rather than introducing database enums in the
first migration. They already express the valid sets; enums would add deployment
coupling without changing business authority. Application state transitions still
need concurrency-safe predicates and transaction boundaries.

Translate the seven existing SQLite triggers into shared PostgreSQL trigger
functions, preserving their exact intent:

| Trigger | Current source | Preservation and proposed tightening |
| --- | --- | --- |
| `published_procedures_cannot_change` | `sqlite-schema.ts`:73–77 | Reject UPDATE to immutable published executables. |
| `published_procedures_cannot_be_deleted` | 79–83 | Reject DELETE even when unused. |
| `plan_revisions_cannot_change` | 139–143 | Reject UPDATE; do not add unconditional DELETE prohibition. |
| `plan_revision_definition_is_immutable` | 145–156 | Pin digest and resolved composition; decide text versus semantic JSON equality explicitly. |
| `compiled_checks_cannot_change` | 170–174 | Reject UPDATE, preserving existing owned-history removal. |
| `attempts_require_active_plan` | 319–327 | Refuse admission when escalated; a trigger query alone does not establish cross-transaction serialization. |
| `plan_revisions_require_active_plan` | 329–337 | Refuse revision insertion when escalated; apply the same Plan serialization discipline. |

Candidate tightening, each subject to existing-data validation and public
acceptance evidence:

- Add update protection to immutable Fact, Snapshot, receipt and catalog revision
  rows. Do not claim SQLite already enforces this: it currently has no such
  triggers. Preserve the public Plan removal path at `plan/store.ts`:127–135,
  which deletes owned history in dependency order while retaining Facts. The public
  gate restricts removal to independent dry-run Plans; live Plans and any Plan
  participating in child composition history are refused (`plan/runtime.ts`:307–331).
  A blanket
  no-delete history trigger changes that behavior and requires a product decision.
- Enforce Snapshot `(state,verdict)` pairing:
  `satisfied/VALIDATED` or `open/NOT_VALIDATED`, matching
  `plan/runtime.ts`:1187–1194. Consider Attempt terminal-state/null-field coherence
  after auditing all transitions. Do not infer that expired Sessions always have
  `closed_at`, since `SessionStore.changeState` accepts optional closedAt.
- Strengthen active qualification Snapshot correlation using
  `(snapshot_id,plan_slug,check_uri,compiled_digest)` against a corresponding
  Snapshot unique key. **Do not include active `plan_revision` in that FK.**
  Qualifications carry forward to new revisions (`plan/runtime.ts`:1170–1179),
  and a newly qualified Check points from the next revision to a Snapshot of the
  admitted revision (1205–1217). Requiring same revision would break normal use.
- Consider `(plan_slug,plan_revision)` FK on escalation's current revision and
  `(child_plan,observed_revision)` on child generations, after verifying update
  ordering and removal paths. Do not invent an invocation FK: invocation definitions
  live in immutable revision documents and evolve by generation.
- Do not automatically add Plan → published Procedure FK. Inline accepted missions
  persist compositions without reusable catalog publication. Do not automatically
  add Plan/Attempt → Environment FK: configuration removal currently exists and
  historical environment names are retained. Catalog metadata has a polymorphic
  Operation/Procedure identity, and Operations are currently file-backed; a
  superficial FK would not express that boundary.
- Do not add Fact → Check/Attempt FK. Content-addressed Facts are deliberately kept
  after Plan removal. Receipt FKs already supply attempt attribution while present.
- Deferrable FK from `(plans.plan_slug,current_revision)` to revisions is possible,
  but initial insertion creates the Plan before its first revision
  (`plan/store.ts`:56–97). It is a separate tightening proposal with transaction
  coverage, not an immediate non-deferrable FK.

SQL cannot replace the complete acceptance of a Fact batch before any append,
qualification or revision. Keep those boundaries in `plan/runtime.ts`:964–977 and
the surrounding ingestion transaction. Concurrency and lock-order changes are
covered by the coordinator's separate runtime analysis. In particular, the
SQLite-style no-op Plan update (`plan/store.ts`:147–155) and pending Attempt update
(`attempt/store.ts`:57–65) must not be interpreted as a finished PostgreSQL locking
design merely because their SQL executes.

## Indexes justified by current query shapes

No inspected store filters inside a JSON document. Catalog search expands
classification in JavaScript (`catalog/metadata.ts`:155–166), and operation lookup
scans compiled Procedures (`procedure/store.ts`:83–95). **No blanket GIN index is
justified by those queries.** JSONB can improve validation and future structured
queries, but it does not prove a performance improvement for full-document reads.

Candidate B-tree indexes to measure on realistic copies are:

| Candidate | Current query evidence | Why it may help |
| --- | --- | --- |
| `attempts(check_uri,attempt_order DESC)` | `attempt/store.ts`:86–102 | Latest admission/history for one Check currently lacks that prefix index. |
| `attempts(plan_slug,attempt_order DESC) WHERE state='pending'` | `attempt/store.ts`:106–117 | Pending-attempt scan; keep expiry as a query filter, not a time-relative partial-index predicate. |
| `compiled_checks(check_uri,plan_revision)` | `plan/store.ts`:328–335 | Current Check URI lookup; existing PK begins with Plan slug. |
| `check_snapshots(check_uri,calculated_at DESC,snapshot_id DESC)` | `snapshot/store.ts`:79–97 | Per-Check latest/history ordering. |
| `check_snapshots(calculated_at DESC,snapshot_id DESC)` and optionally Plan-prefixed form | `snapshot/store.ts`:101–143 | Global/Plan history pagination. Choose from observed workloads rather than creating every variant. |
| `plans(created_at DESC,plan_slug ASC)` | `plan/store.ts`:289–314 | Keyset listing; optionally add procedure prefix only if selective workloads justify it. |
| `sessions(plan_slug,opened_at DESC)` | `session/store.ts`:53–59 | Session history, separate from the existing open-session partial index. |
| `plan_escalations(plan_slug,escalated_at,escalation_id)` | `plan/escalation-store.ts`:64–71 | Ordered escalation history. |

Keep the ordered-list uniqueness of Snapshots until an alternative deduplication
design is approved. A large `fact_ids_json` in a B-tree unique key can exceed
PostgreSQL index-entry limits; changing text to JSONB does not remove that risk.
The import study must inventory maximum list/key sizes and exercise representative
large batches. A fixed-size equivalence digest plus exact-list collision checking
is an alternative; a hash alone must not silently redefine exact equivalence.
Likewise measure long Check URIs in composite indexes.

Changing collation can alter text ordering and pagination. PostgreSQL/PGlite must
use the same explicitly chosen comparison semantics for slugs, URIs, digest text
and cursor tie-breakers. Preserve current byte-sensitive equality; do not switch
these identities to case-insensitive types or nondeterministic collations.

## Import evidence required before accepting these proposals

The coordinator's conservative import plan must preserve the untouched SQLite
original and verified backup, all IDs and generated sequence positions, exact
sources and digest strings, and the Operation catalog outside SQL. Operations are
read and written as `.feature` files (`operation/catalog.ts`:70–129, 165–180), so
19 copied tables alone do not constitute a complete runtime migration.

For each candidate type change, a copy-based importer should produce a report of
row counts, NULL counts, bounds/shapes, referential validity and canonical semantic
comparison while keeping sensitive values out of diagnostics. Required schema
acceptance cases through public runtime boundaries include:

- Import, list and resume old Plans with byte-identical sources, pinned nested
  composition, accepted inline missions and unchanged semantic Check URIs.
- Exercise a no-op declaration/replay and an actual next revision of imported
  composed Plans: no unexpected child supersession, Result reordering, revision,
  qualification or digest change caused by JSON key order.
- Re-observe accepted Facts with non-UTC/alternate timestamp spellings, nested
  object keys, explicit null/absence and array order/duplicates; verify preserved
  IDs, duplicate handling and no spurious Snapshot/checklist delta.
- Verify UUID candidates, bigint/affected-row decoding, tombstone recreation,
  nullable Attempt finalization and runtime timestamp/cursor output on both modes.
- Verify status/FK/immutability tightening through relevant public workflows,
  including Plan removal retaining Facts and qualifications referencing older
  revision Snapshots. Do not substitute unit tests or direct SQL inserts for the
  public behavior evidence.
- Check index entry limits and representative query plans/sizes on PostgreSQL
  copies; benchmark both engines before asserting performance gains.

This study did not run those acceptances, write the importer, or validate either
adapter. A complete `code-moniker check . --report` run after the study documents
were added scanned 669 files and returned zero violations. This is structural
evidence only; it is not behavioral migration validation. The coordinator also
ran an earlier full gate before these documents existed.

## Decisions to carry into the consolidated study

Mechanical mappings with low semantic risk are the three booleans, existing
constraints translated faithfully, exact text preservation, and one common
persistence API. UUID and typed runtime timestamps are conditional on full source
inventory and consistent decoding. JSONB is useful for semantic documents but must
not enter composition history before the order-sensitive consumers are resolved.

The following choices need explicit design treatment before implementation:

1. Preserve byte equality for pinned resolved composition, or adopt semantic JSON
   equality while separately preserving exact sources.
2. Transition child-input/imported-Result hashing without changing existing child
   identities or causing synthetic revisions. Keeping selected JSON text first is
   the conservative option; pervasive historical JSONB conversion is not mechanical.
3. Keep ordered Snapshot Fact-list text, use JSONB equality, or introduce normalized
   membership/fixed-size equivalence keys with collision-safe comparison.
4. Choose counter width/decoding, timestamp exactness and UUID casts from measured
   retained data; never infer identity type from a column suffix.
5. Decide which additional immutable-update, state coherence and FK constraints
   are invariants already implied by public behavior, versus actual product
   tightening. Keep Plan-owned-history removal and reusable prior Snapshots intact.

The future schema/adapter lot depends on these choices. Store codec changes and
digest-preservation work precede broad JSONB import; copy-based import validation
precedes activation. No source data, backup or live runtime was modified by this
analysis.
