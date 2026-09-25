# Conservative SQLite import

The core uses one PostgreSQL schema on PostgreSQL server and PGlite. SQLite is an
explicit import source only. Each database has exactly one active TRUST runtime
owner; the importer takes the same ownership lock. Separate installations keep
separate databases and Operation catalogs. This command never activates a runtime,
changes its configuration, merges installations, or synchronizes databases.

Build the runtime first. Select the exact source SQLite file and Operation catalog
from the installation configuration. Choose an unused private archive directory
whose parent already exists and either a new PGlite directory or a separately
provisioned empty PostgreSQL database. Never select an existing installation as the
target. Do not remove an old backup to make a pathname available.

```sh
node packages/trust-runtime/scripts/import-sqlite.mjs \
  --source /absolute/retained/runtime.sqlite \
  --operations /absolute/retained/operations \
  --archive /absolute/backups/new-import-archive \
  --pglite /absolute/new-installation/pglite
```

For PostgreSQL, pass the name of an environment variable containing its connection
string; keep credentials out of process arguments, reports and source control:

```sh
node packages/trust-runtime/scripts/import-sqlite.mjs \
  --source /absolute/retained/runtime.sqlite \
  --operations /absolute/retained/operations \
  --archive /absolute/backups/another-new-import-archive \
  --postgresql-env TRUST_IMPORT_DATABASE_URL
```

## Guarantees and refusals

1. Open the source read-only and verify SQLite integrity, foreign keys, exact
   schema definitions and the known schema marker. An extra table, changed trigger
   or unknown schema is a refusal even if somebody retained the old marker.
2. Use Node's online SQLite backup API, including committed WAL contents, into the
   newly reserved archive. Reopen and independently verify that consistent copy.
   The main source, WAL/SHM, earlier backups and configuration are never written.
3. Copy the complete Operation directory byte for byte and compare SHA-256 file
   manifests before and after copying. Refuse symlinks and publication changes
   during the copy. The archive and its files use private permissions. Keep this
   archive private: the database contains Environment values and credentials.
4. Validate all JSON documents before opening the target. Invalid UTF-8, duplicate keys, NUL,
   unpaired Unicode surrogates and numbers whose decimal value changes through the
   runtime JSON codec are refused with table/row/column coordinates. Nothing is
   silently sanitized. Exact source text and external timestamp spelling remain
   exact; runtime timestamps must already be UTC with millisecond precision.
5. Reconstruct each current child-generation signature from the original ordered
   JSON and dependency history. Compare its legacy SHA-256 with `input_digest`
   before adding the canonical comparison fingerprint. Refuse a missing or
   ambiguous reconstruction. Superseded rows retain their historical digest and
   may have a null comparison fingerprint. Existing children are never regenerated.
6. Require empty application tables in the target, then insert the complete
   history in one transaction with the new schema's constraints active. Preserve
   identifiers, sources, existing digests, revision numbers, Plan heads, Facts,
   receipts, Snapshots, qualifications and escalation state. Translate JSON to
   JSONB, 0/1 to boolean and runtime instants to typed timestamps. Reject integers
   outside the common driver's safe-number contract.
7. Compare every imported column of every application row after driver decoding.
   JSON objects compare semantically, arrays retain order and multiplicity; text,
   identifiers and digests compare exactly. Write table counts and comparison
   hashes to `import-manifest.json` only after all comparisons pass. Preserve the
   `attempts` AUTOINCREMENT high-water mark, even when its last rows were deleted,
   and advance the revision identity sequence above all imported IDs.

`source-manifest.json` records original row-content hashes, SQLite schema digest,
sequence values and Operation file hashes. `source.sqlite` is the exact consistent
archive for byte-sensitive historical reconstruction. Target schema metadata is
its own version/checksum; the old SQLite marker is provenance, not target schema.
The target directory may exist after a refused import, and schema creation is
separate from the all-row import transaction. Keep the failure archive, investigate
the named incompatibility, and use a new destination for another PGlite attempt.
The command never deletes a failed target automatically.

## Copy validation and activation

Online backup is suitable for rehearsal while a source runtime is active. It is
not a cross-resource atomic snapshot with the file-backed Operation catalog, nor a
final cutover while the old runtime keeps accepting writes. For final activation:

- Identify the runtime owner, SQL source, Operation directory, authority, private
  configuration and extension roots. Do not change other extensions' databases.
- Stop admission/writes and publication for that installation during the approved
  maintenance window. Take a fresh uniquely named archive and import again.
- Start one target runtime using the imported database and archived Operation
  directory, preserving authority/configuration. Through RPC/MCP verify Plans,
  history, publications, Environment/credential references and resumed child
  generations. Exercise continuing an existing Plan on a disposable rehearsal
  first; builds and direct row comparisons alone are not behavioral proof.
- Recheck the complete manifest and restart persistence before enabling normal
  clients. Keep the original SQLite installation and archives intact.

Before target writes are admitted, rollback means stopping the target and restoring
only the old runtime configuration. Once the target accepts new history, the old
SQLite database is stale. Reverting then would lose accepted work: stop admission,
preserve both histories and plan an explicit recovery. There is no automatic
reverse import or dual-write mode. The command does not make that deployment choice.

## Public acceptance

`acceptance/storage-import.acceptance.test.ts` invokes the real import CLI, checks
source preservation and the complete manifest, then starts and restarts the real
runtime and reads imported Environment data through RPC. It also verifies occupied
target refusal, schema tampering and JSON incompatibilities before target creation.
Set `TRUST_ACCEPTANCE_POSTGRES_URL` to a task-owned server's administrative database
to provision a unique disposable PostgreSQL target; otherwise use PGlite. Test
cleanup drops only the database that the test itself created. Full copied retained
Plan/history and next-revision journeys are required in the integration review in
addition to these isolated import-boundary acceptances.

For an explicitly selected retained copy, enable the additional public continuation
journey with `TRUST_IMPORT_RETAINED_SOURCE`, `TRUST_IMPORT_RETAINED_OPERATIONS` and
optionally `TRUST_IMPORT_RETAINED_PLAN` (default:
`hall-npm-server-preparation-2026-09-25`). It imports into another fresh target,
reads every retained Plan and published Procedure, compares every Snapshot ID via
paginated public history, appends one new mission on the copied Plan, and verifies
that all existing child IDs/generations survive the next revision and restart.
It invokes no Runner or external action. Its source archive is deliberately kept
for independent review; only its task-owned PostgreSQL target is dropped.

## Evidence from the 2026-09-25 implementation rehearsal

The complete retained project snapshot imported into both PGlite and PostgreSQL:
65 Plans, 291 revisions, 37 child generations, 26 publications, 128 Attempts,
121 Facts, 121 receipts, 121 Snapshots, 432 active qualifications and three
escalations. Every application column passed comparison; the Attempt watermark
remained 128 and the revision identity watermark 291. The public continuation
journey on `hall-npm-server-preparation-2026-09-25` added a mission and a new child
while preserving all four existing child identities and generations on both
engines, including after restart. Nine import acceptances passed on each engine, including committed-WAL capture
without source main/WAL changes and rejection of malformed UTF-8.

An independent mobile core snapshot imported into PGlite with 18 Plans, 55
revisions, 13 child generations, two publications and 18 Facts/Snapshots. This
copied only the mobile installation's **core** database; its extension database
was not changed.

The original project SQLite snapshot already contains an older pinned definition
for `agent-delegation-20260909` whose declared invocation `execute-work` omits
`materializes`. Reading that Plan succeeds, but appending another mission returns
`invalid-plan-declarations` (`invocation.materializes is not iterable`) on both
target engines. This is a pre-existing definition limitation, not an import data
change. No historical definition was silently rewritten. It does not invalidate
row preservation or supported reads; supporting a new append to that older
composition requires separate explicit treatment of its historical contract.

No retained installation was activated or reconfigured by these rehearsals.
