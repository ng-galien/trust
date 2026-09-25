# Core storage

Each TRUST database has one active runtime owner. Multiple clients, agents and
Runners use that runtime concurrently. Independent installations may use distinct
PostgreSQL databases on one server, or distinct PGlite directories. They do not
share Plan state, event streams, caches or filesystem Operation catalogs.

The core stores use a single PostgreSQL schema and query implementation. PostgreSQL
is the reference engine; PGlite runs the embedded form through a narrow driver that
reserves its one connection for each complete transaction. PostgreSQL uses a pool
and can execute transactions for unrelated Plan compositions concurrently. Changes
and assembled reads in one composition take its root lock before Attempt locks.

## Runtime configuration

| Setting | Meaning |
| --- | --- |
| `TRUST_STORAGE=pglite` | Embedded engine; default for a new installation |
| `TRUST_PGLITE_DIRECTORY` | Durable embedded directory; direct runtime default `.trust/pglite` |
| `TRUST_STORAGE=postgresql` | PostgreSQL server engine |
| `TRUST_DATABASE_URL` | Required PostgreSQL connection URL; supply privately |

The common CLI/Electron shell defaults the embedded directory to `pglite` under
its selected state directory. The Operation directory is separate and must remain
with its installation. Backend selection is explicit: a URL without PostgreSQL
selection or simultaneous target settings is refused. `TRUST_DATABASE_PATH` is
retired. Discovery of a retained SQLite file at a former default refuses an
implicit empty start. Startup never performs an import.

PostgreSQL ownership uses a dedicated session advisory lock scoped to the selected
database. A second owner is refused. Losing that session disables future pool
acquisitions and terminates known pool sessions. Ownership is released after pool
shutdown. PGlite ownership uses an exclusive durable marker beside its canonical
directory. Graceful shutdown removes only its own marker. After a crash, startup
fails closed: an operator must verify the former owner has stopped before removing
the exact marker named by the diagnostic. There is no automatic stale takeover.

## Representation and history

All 18 document/list columns are JSONB. Object key order has no business meaning;
array order and multiplicity remain significant. Source strings, identifiers and
historical digests remain exact. Child generations retain their original
`input_digest`; a separate canonical comparison fingerprint prevents a JSONB key
reordering from replacing a child. Snapshot equivalence uses a bounded digest plus
an exact tuple/list comparison to detect collisions.

Stored flags are boolean. Internal UUID identifiers are typed UUID, while public
slugs and semantic URIs remain text. Runtime timestamps are `timestamptz(3)` and
read as UTC ISO strings. External observation and receipt spellings remain text
because they contribute to historical identity. Bigint counters and revisions are
checked against JavaScript's safe integer range and decoded identically on both
engines. Text comparison uses the `C` collation.

Schema preparation creates only an empty target and records its version and DDL
checksum separately from business history. An incompatible existing schema is
refused. There is no automatic generic migration or reset. The previous SQLite DDL
is retained solely to verify explicit imports and legacy archive tooling.

## Import and activation

Follow [Conservative SQLite import](../verification/storage-import.md). The tool
makes a new verified online backup, archives the Operation catalog, validates every
conversion, imports in one transaction and compares every application row. It
preserves sequence high-water marks and verifies old child signatures before
adding comparison fingerprints. A refused row is never silently repaired.

Rehearsal on a copy and final activation are separate operations. Activation needs
an identified target and a maintenance window that stops writes to the old runtime
and Operation catalog before a fresh import. Keep source, WAL/SHM, earlier backups
and extension data. No dual writes, synchronization or automatic reverse import is
provided. A return to SQLite after new target writes would discard accepted history
and requires an explicit recovery plan.

## Public verification

The same runtime acceptance helper runs on PGlite by default. With
`TRUST_ACCEPTANCE_POSTGRES_URL` pointing to a task-owned administrative database it
creates a distinct PostgreSQL database for each test target and drops only those
created databases afterward. Restart journeys retain their test target. New
storage foundation, concurrency and import acceptances use real runtime processes,
RPC/OTLP or the import CLI. Direct row comparisons supplement public continuation
and restart checks; builds and typechecks do not establish behavioral parity.
