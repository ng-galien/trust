# Verified delegation: executed tests before completion

`agent-delegation@1.1.0` adds mandatory unit, integration and database verification
to the existing coordination workflow. `agent-delegation@1.0.0` and its Operations
remain unchanged. This is a coordination Procedure using native Checks, Facts,
Scenario dependencies and materialized roles, not a new runtime evidence resource.

## Contract and sequence

Use [the engagement example](engagement.example.json) as an exact request shape.
Its examples verify **this delegation mechanism**, not an ABAC implementation.
Replace their immutable requirement groups with the assigned implementation's
actual requirements and test names before engaging that mission.

Existing root inputs remain `mission`, `assignee`, `project`, `instructions`,
`expected`, `authorized`, `forbidden`. New roots are `reviewer`, `unit verification`,
`integration verification`, `database verification`. The latter three are JSON
strings because the canonical Procedure language owns scalar/collection roles;
the bounded Operation input contract validates their structure. `response` and
`outcome` remain revision-checked agent declarations. Observed digests and fixed
layer/capture values are never repeated as engagement inputs.

Each required group contains exactly:

```json
{
  "id": "ABAC-plan-read",
  "layer": "integration",
  "requirements": ["ABAC-PLAN-READ"],
  "testFiles": ["acceptance/plan-read.test.mjs"],
  "assertions": [{
    "requirement": "ABAC-PLAN-READ",
    "file": "acceptance/plan-read.test.mjs",
    "name": "ABAC-PLAN-READ another principal cannot read this Plan"
  }],
  "sourcePaths": ["src/authorization"],
  "artifactPaths": ["dist/authorization"]
}
```

Paths and assertion names above are illustrative, not existing ABAC tests.
`requirements`, `testFiles`, `assertions`, `sourcePaths` and `artifactPaths` must be
nonempty. Every requirement needs an expected named test assertion. Duplicate
file/name pairs, undeclared keys, invalid layer, escaping paths and symlinks are
refused. Name and file must match one actual Node test result exactly; suites and
synthetic file success are not named assertions. A file that exits successfully
without tests has zero observed tests and cannot qualify.

The order is:

1. Create the mission through the existing PostgreSQL Operation, then claim it.
2. Worker runs `verify unit`, `verify integration`, `verify database` through the
   packaged Runner. Each succeeds only when actual tests pass and the corresponding
   requirements' named assertions are present once, with no failures, skips, TODOs,
   crash/cancellation or code changes during execution. Each Check materializes
   its observed source/artifact digest.
3. The independent coordinator reads assertion source, checks requirement coverage,
   execution targets, build provenance and source closure, then executes `review
   unit`, `review integration`, `review database`. The same tests run **again**;
   the required digest comes from the upstream qualified worker Check, not a new
   agent declaration. Different observed bytes refuse verification before testing.
4. Only all successful review Checks permit `submit response`. An early completed
   declaration is insufficient and does not write a completed coordination row.
5. The coordinator performs final `observe completion`. A stored response does
   not by itself complete the Plan or the governed board projection.

Always obtain the actual Check URI from `trust_plan_read` or the preceding Runner
result. Supply its current intent and announced next intent as required; never
construct an opaque Check identity. Each continuing Check may be executed by the
host responsible for that phase. Do not invoke the independent review Checks on
behalf of your own real implementation mission.

## Execution and observations

`coordination.verification-run@1.0.0` runs the fixed
`scripts/coordination-verification.mjs` under Environment `workspaceRoot`.
For the dedicated local installation that directory is exactly the authorized
TRUST checkout. The helper supports Node's test API only, with explicit files,
process isolation, concurrency one, empty test arguments/exec arguments and a
120-second group deadline. It never accepts a command string or reads a submitted
report JSON. Inherited Node preload/filter context is removed before test children
start. Test stdout/stderr is bounded and is never parsed as successful test events.
The Node test runner's own event stream provides named results and counts.

The helper produces a fixed line protocol, projected by canonical JSONata into
complete Produced fields: `contractId`, `layer`, `sourceDigest`, `afterDigest`,
`tested`, `passed`, `failed`, `skipped`, `crashed`, `missing`, `stale`, `complete`,
`runId`, `report`. Every failed/zero/skipped/crashed/stale run emits actual negative
observations, accepted by TRUST as Facts and qualified `NOT_VALIDATED`; malformed
contracts or missing files instead fail execution without qualifying a Check.
`complete` describes the observed test run, not the Plan. Procedure guards also
check individual counts and digest equality. Only TRUST returns the verdict.

The JSON string `report` includes requirement IDs and each expected file/name with
its observed status; actual Node runner summary counts; Git HEAD (or `unversioned`
in a fixture); start/end timestamps; Node version; absolute executable, cwd and
exact `node:test.run` configuration; execution ID and fresh run ID; and every
hashed file. The digest includes declared source and artifact closures, tests,
assertion files, this helper's actual bytes, Node version, contract, and local
`package.json`/`package-lock.json` when present. The pre/post snapshots detect
ordinary file changes during execution; they are not an adversarial filesystem
snapshot. Tests do not run against an isolated Git worktree.

There are bounds of 256 entries per contract list, 20,000 hashed files, 128 MiB
hashed content, 10,000 reported test outcomes and 1 MiB child output. The packaged
Runner's own output/request bounds still apply: excessively large reports fail
rather than silently truncating into success. Do not include secrets in test
names, paths, contract inputs or diagnostics. External test credentials remain
host environment values, not Plan inputs or reports.

[Node's test runner documentation](https://nodejs.org/api/test.html#runoptions)
describes the process-isolated execution API and its result stream. This helper
uses named test outcomes; it does not infer whether an assertion is meaningful
from its name. Prefer explicit `t.plan()`/assertions in authored tests, and review
them independently.

## What the mechanism does not prove

- `layer` is an immutable **classification**, not automatic proof that a test is a
  real integration/database test. The reviewed assertions must exercise real
  public boundaries and database behavior. Mocked or vacuous passing assertions
  remain a review failure even if a test runner calls them passed.
- Hashing both source and `dist` proves which bytes were observed, not that one was
  built from the other. Build before verification, retain its readable build
  provenance where appropriate, include actually executed `dist` and dependencies
  in the contract, and require independent review of the build relationship.
  There is no automatic build attestation or arbitrary build-command facility.
  Package-lock bytes do not prove an installed dependency tree matches that lock.
- The source/artifact closure is explicitly scoped, not discovered by a parallel
  architecture analyzer. Use Code Moniker when dependency evidence is required;
  the coordinator must inspect that the declared closure covers execution.
- Independent reviewer names are distinct in the qualification guard, and the
  Check scopes assign review exclusively to that reviewer. The existing runtime
  does not authenticate this actor identity. A trusted host must enforce the
  handoff. This bootstrap cannot prevent an authorized worker from impersonating
  its reviewer or altering the execution helper. Native caller authorization is
  separate work; this Procedure makes no cryptographic independence claim.
- A satisfied live Check cannot be re-observed. If code changes after verification
  or review, engage a clearly linked new mission/Plan with current contracts and
  repeat the complete workflow. Do not reset, rewrite immutable roots or invent a
  live Check refresh. A future runtime feature would require its own authority.
- The final observation does not continuously monitor code after review. The
  coordinator must check that the reviewed state still describes the delivered
  result, and use a new mission if it does not. No release/deployment or guarantee
  of ABAC behavior follows from this mechanism's own acceptance suite.

## Verification performed and reproducible commands

The helper acceptance exercises green and fresh rerun, failed assertion, zero
actual tests, required skip, child crash, printed fake report, stale source and
compiled artifact, mutation during execution, escaping/symlink paths, missing
name and unmapped requirement. Eleven named tests passed.

The public acceptance starts a disposable runtime and creates one unique
PostgreSQL database. It compiles the new sources, executes real packaged Runner
Checks with RPC admission and OTLP Facts, verifies six success/failure variants,
and observes persisted mission/event history. Its integration test includes actual
HTTP Plan reads; its database execution checks transaction, insert/select and
rollback. Negative completed declarations cannot bypass the verification or
review dependencies. The positive fixture deliberately exercises both worker and
reviewer paths as a **test harness**, not independent review of this assignment.
One integration test plus its named database subtest passed. All 13 tests passed
with zero failures, cancellations or skips; test databases were dropped afterward.

From this checkout, using the already authorized credential file without printing
it:

```sh
source .trust/storage-study-20260925/environment
node --test extensions/coordination/acceptance/verification-helper.test.mjs extensions/coordination/acceptance/verification-runtime.acceptance.test.mjs
code-moniker check . --report
```

The runtime test requires `TRUST_COORDINATION_DATABASE_URL` (or
`COORDINATION_VERIFICATION_DATABASE_URL`) and the existing `PGPASSWORD`. It fails
if the administrator connection is unavailable; it never converts missing DB
coverage into a skip. The configured user must be allowed to create/drop only
those unique test databases. Their schemas are initialized from the existing
mission schema; mission transitions themselves use the Runner, never direct SQL.

When those same tests are invoked by the packaged Runner, its normal Shell
sanitization removes `TRUST_*`. The invoking host may pass the non-secret URL
alias using its already configured value, without printing it:

```sh
export COORDINATION_VERIFICATION_DATABASE_URL="$TRUST_COORDINATION_DATABASE_URL"
```

This only configures the invoking process; it does not edit the persistent
Environment or a running service. `PGPASSWORD` stays in the process environment.
Neither the helper nor these acceptances modifies retained coordination schemas,
Plans or service configuration. Public publication/coordination calls on 4510
are tracked separately from the disposable tests and independent review.
