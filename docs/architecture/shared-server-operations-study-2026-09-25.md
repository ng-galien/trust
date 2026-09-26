# Shared server: workstation onboarding and operations study

Date: 2026-09-25. Status: source-based study; no deployment or functional change.

The operating model is several people and agents using one central TRUST runtime,
with exactly one runtime owner per database. Workstations use public interfaces;
they do not open the core database. This study covers onboarding, execution hosts,
credentials, extensions, notifications, recovery and bounded load. It does not
propose database synchronization or multiple active runtimes against one database.

## Recommended minimum

Use one central runtime with PostgreSQL when a team needs shared Plans and catalog
history, and deploy the packaged Runner on each workstation that executes local
repository work. Keep server-side execution an explicit capability, with a
separate execution account and deliberately provisioned external permissions.
PGlite remains an option for a single runtime installation; choosing PostgreSQL
does not itself add user accounts, runtime authorization or availability.

The current code supports the central state and remote protocol pieces. It does
not yet establish distinct human or agent permissions. An access gateway can
control who reaches the server, but the runtime currently treats admitted clients
as sharing its authority. A small team may deliberately accept that common trust
boundary; separate rights require an authorization design and public acceptance
before exposure. This is a product/deployment choice, not an assumed approval to
install an identity service.

Three boundaries must remain explicit:

- **Server access:** which person or machine may reach MCP, RPC, telemetry and streams.
- **TRUST authority:** which Plans, environments, catalog changes and server-side capabilities that client may use.
- **External execution:** what the Runner's OS account, process environment and network credentials permit on its execution host.

A Check grant correlates execution and accepted Facts; it is not an OS sandbox or
proof that an external action occurred. The Runner admits, executes, exports Facts
and asks TRUST to finalize qualification in that order
([Runner orchestration](../../packages/trust-runner/src/check/run.ts#L77)).

## Capability assessment

“Existing” below means visible in inspected source, not remotely deployed or
validated by this study. “Reinforce” identifies an existing mechanism whose
operational boundary is incomplete. “Absent” is scoped to the inspected paths.

| Concern | Existing | Reinforce or absent | Source evidence |
| --- | --- | --- | --- |
| Workstation installation | Operational skill plus packaged Runner; atomic replacement of its directory | Document central server identity and update ownership; MCP setup alone is insufficient | [Installation](../agents/install-in-project.md#L18), [deployment](../../packages/trust-shell/src/runner-deployment.ts#L60) |
| Remote protocol routes | Runtime mounts `/mcp`, `/rpc`, `/v1/traces`, events and extensions | No principal authentication/authorization middleware in this mounting path; protect direct backend access | [HTTP composition](../../packages/trust-runtime/src/http/app.ts#L23) |
| Web access gate | Optional shared Basic password on the shell's web server | Shared credential, no individual identity; Basic is stripped upstream. Its proxy path list omits `/v1/traces` | [gate](../../packages/trust-shell/src/server.ts#L219), [stripping](../../packages/trust-shell/src/server.ts#L303), [paths](../../packages/trust-shell/src/server.ts#L19) |
| Runner connectivity | Configurable RPC and OTLP endpoints; HTTPS or loopback HTTP; request timeouts | RPC and OTLP send fixed JSON headers, without configurable per-client authorization; embedded URL credentials refused | [RPC](../../packages/trust-runner/src/check/client.ts#L60), [OTLP](../../packages/trust-runner/src/telemetry/otlp.ts#L29), [URL validation](../../packages/trust-runner/src/http/request.ts#L113) |
| Environments | Named persisted value maps; admission projects the Operation's declared keys | Names are global, not user/workstation scopes; list exposes ordinary values, saves replace the map without a revision check | [service](../../packages/trust-runtime/src/environment/service.ts#L13), [MCP](../../packages/trust-runtime/src/http/mcp-authoring.ts#L675), [admission](../../packages/trust-runtime/src/plan/runtime.ts#L893) |
| Credentials | Separate service lists names and stores/resolves values | Inspected SQL store persists values directly; no per-user isolation or encryption wrapper there. Live admission uses ordinary Environment values, not this credential resolver | [service](../../packages/trust-runtime/src/credential/service.ts#L25), [store](../../packages/trust-runtime/src/credential/store.ts#L12), [admission](../../packages/trust-runtime/src/plan/runtime.ts#L905) |
| Local execution | Packaged Runner executes the admitted Operation on its caller's host | Shell inherits most host environment variables and OS privileges; working-directory validation is not command isolation | [spawn](../../packages/trust-runner/src/shell/run.ts#L52), [ambient environment](../../packages/trust-runner/src/shell/run.ts#L157), [paths](../../packages/trust-runner/src/lib/paths.ts#L21) |
| Server execution | Operation Trial spawns the packaged trial script on the runtime host | It inherits runtime process environment and accepts authored source; restrict this capability before giving clients different authority | [source compilation](../../packages/trust-runtime/src/trial/service.ts#L179), [spawn](../../packages/trust-runtime/src/trial/service.ts#L198) |
| Catalog reuse | Explicit registry sync verifies artifacts and immutable identities, imports Operations before Procedures | Curate who may publish/sync; Operation files and SQL publication state need coordinated backup | [registry](../../packages/trust-runtime/src/registry/service.ts#L115), [import order](../../packages/trust-runtime/src/registry/service.ts#L194), [Operation files](../../packages/trust-runtime/src/operation/catalog.ts#L34) |
| Extensions | Manifest grants for Plan reads/subscriptions, configured Environment filtering, constrained child environment | Grants constrain SDK access, not same-OS-user filesystem/network access; start/stop/commands need caller authorization | [manifest](../../packages/trust-runtime/src/extensions/manifest.ts#L74), [host](../../packages/trust-runtime/src/extensions/host.ts#L115), [HTTP](../../packages/trust-runtime/src/http/extensions.ts#L26) |
| Notifications | SSE, heartbeat, cursor replay and resync; SQL is the Plan source of truth | General Plan stream has no per-user filter; replay is bounded and memory-only, not a durable notification inbox | [event history](../../packages/trust-runtime/src/plan/events.ts#L7), [SSE](../../packages/trust-runtime/src/http/events.ts#L11) |
| Storage owner | PostgreSQL owner connection/advisory lock, fail-closed loss; PGlite directory ownership | Maintain one owner through restart/restore; no runtime failover or synchronization implied | [PostgreSQL](../../packages/trust-runtime/src/database/postgres.ts#L24), [directory ownership](../../packages/trust-runtime/src/database/ownership.ts#L12) |
| Service readiness | Startup serves 503 until initialization; graceful close path | Current health reports `ok` from the clock only, even though storage ownership can later become unavailable | [startup](../../packages/trust-runtime/src/server.ts#L72), [health](../../packages/trust-runtime/src/health.ts#L20), [owner loss](../../packages/trust-runtime/src/database/postgres.ts#L34) |
| Bounded work | Body limits, subprocess/request timeouts, bounded output/event retention and database pool | No demonstrated total workload bound: RPC batch fan-out, waiting queries and active Trials need explicit admission limits | [RPC batch](../../packages/trust-runtime/src/http/rpc.ts#L775), [Trial registry](../../packages/trust-runtime/src/trial/registry.ts#L16), [pool](../../packages/trust-runtime/src/database/postgres.ts#L25) |
| Recovery | Conservative SQLite import preserves source and archives Operations | Import is not a general PostgreSQL/PGlite backup and restore service; define combined backup and recovery procedure | [import verification](../verification/storage-import.md) |

## Network and identity contract

A workstation needs **MCP plus Runner RPC and OTLP**, targeting the same runtime.
The existing installation guide already distinguishes these endpoints
([configuration](../agents/install-in-project.md#L55)). A browser reaching the UI
therefore does not prove that an agent's Check can execute and submit Facts.

| Surface | Purpose | Deployment requirement |
| --- | --- | --- |
| `/mcp` | Agent discovery, authoring and Plan reads; tool change stream | Protect all methods and long-lived streams; verify the client's MCP transport supports the chosen gateway |
| `/rpc` | Runner admission/finalization and application operations | Same identity and policy boundary as MCP, not an unprotected alternative |
| `/v1/traces` | Runner Fact submission | Exact path is required by the current exporter; no query/hash or prefixed path such as `/trust/v1/traces` |
| `/events/plans`, extension events | UI/extension rereads after changes | Authorized subscription and replay/resync; proxy must support SSE without buffering |
| `/extensions`, Trial RPC | Executable server capabilities | Explicitly restrict who can invoke/start/configure them |
| LSP WebSocket | Language tooling | Review separately if exposed; it is attached to the runtime HTTP server |
| `/health`, diagnostics | Operations | Separate liveness/readiness and restrict diagnostics as appropriate |

The [exporter](../../packages/trust-runner/src/telemetry/otlp.ts#L29) fixes the
telemetry path. The [runtime](../../packages/trust-runtime/src/server.ts#L155)
attaches the language socket. The shell's shared web gate is not a complete
remote Runner ingress: `/v1/traces` is missing from its proxy paths, and the
Runner does not supply its shared Basic credential. A private non-loopback HTTP
address is also refused by the Runner; private networking alone does not satisfy
its HTTPS-or-loopback rule.

Two minimal deployment options follow from these constraints:

1. **Common-trust pilot through authenticated local forwarding.** An existing
   authorized SSH/private access arrangement could expose the central runtime
   only through each client's loopback endpoint, using credentials managed by
   that transport. This fits current Runner URL rules and avoids placing login
   credentials in URLs. Every admitted client still has shared runtime authority.
   Tunnel reachability, all three protocols and disconnection on revocation need
   acceptance; no tunnel was configured here.
2. **Direct authenticated HTTPS service.** One controlled ingress covers all
   routes, with individual user/machine credentials, Runner authentication support
   and runtime authorization where distinct rights are required. The present web
   password gate is insufficient for this option. A small explicit role/resource
   policy can precede more elaborate identity integrations; no particular SSO
   product is required by this study.

Keep the backend port and database reachable only by intended infrastructure.
Workstations need no core database URL. A PostgreSQL Operation may legitimately
need credentials for its **external target database**, which is a different
permission boundary from TRUST's core storage
([PostgreSQL Runner](../../packages/trust-runner/src/postgresql/run.ts#L29)).

Preserve semantic Check identity when choosing network ingress. The semantic
authority is configured separately in the runtime, but the shell currently sets
it from the bind host/runtime port
([runtime settings](../../packages/trust-runtime/src/index.ts#L26),
[shell settings](../../packages/trust-shell/src/server.ts#L138),
[URI construction](../../packages/trust-runtime/src/check/uri.ts#L29)). Do not
rewrite supplied Check URIs into gateway addresses. Verify the supported
configuration before moving an existing installation behind a new hostname.

## Developer and agent onboarding journey

1. The operator identifies the central runtime, its stable semantic authority,
   access method and permitted scope. Decide whether all participants share full
   runtime trust or need distinct rights. Record who owns catalog administration,
   server Trials/extensions, deployment and recovery.
2. Provision that person's or agent host's transport identity without distributing
   core database credentials. Give both interactive clients and background agent
   processes an intentional access lifetime; a shared browser session is not an
   agent credential.
3. Install the operational skill and exact packaged Runner on the workstation,
   then configure MCP, `TRUST_RPC_ENDPOINT` and `TRUST_OTLP_ENDPOINT` for the same
   central instance. Runner deployment is atomic; updates must replace the full
   package, not individual scripts. Keep endpoint credentials out of reports,
   Check URIs and tracked project files.
4. Read the central catalog and required immutable Procedure/Operation versions.
   Publish or synchronize missing definitions only with the appropriate authority.
   Existing Plans retain their pinned definitions; installing a Runner does not
   publish definitions or select new versions for them.
5. Select an explicit Environment compatible with the execution host. For local
   repository commands, paths refer to the workstation, not the server. Separate
   names for different workstation paths are a workable convention, not access
   control. Ordinary Environment values must remain non-secret; their list/read
   surfaces are shared. Changing a name/value map can affect other users selecting
   it, so assign an operational owner until revision/authorization protection exists.
6. Install the required executable and external permissions on the actual Runner
   host. Prefer short-lived, narrowly scoped provider credentials. Inventory
   ambient process credentials: the Shell runner excludes `TRUST_*` and one named
   authorization variable, not every possible secret. Do not assume the separate
   runtime credential store supplies live admission values; a secure binding and
   redaction design remains work to specify and validate.
7. In a future acceptance environment, prove a read and an explicitly harmless
   Check from that host: supplied URI, successful admission, external observation,
   accepted Facts, explicit verdict and subsequent central read. Verify failures
   for missing external permissions or unavailable executables are understandable.
   This study did not run that journey or authorize an external action.
8. Subscribe to relevant changes and reread authoritative state after reconnect.
   Document where failures are visible and who can revoke access or stop execution.
   Notifications are prompts to reread, not evidence of completion.

## Choose the execution host deliberately

| Execution mode | Suitable use | Rights and operational consequences |
| --- | --- | --- |
| Workstation Runner | Local repository, developer tools, local filesystem | Uses that workstation's OS identity, binaries, network reachability and ambient credentials; central paths do not become local paths automatically |
| Deliberately installed server Runner | Shared automation requiring controlled server access | Needs its own execution account/configuration, bounded concurrency and external credentials; a host scheduler/agent launches it, not the core runtime by implication |
| UI Operation Trial | Authoring diagnostics where server execution is explicitly allowed | Current runtime spawns on its own host, inherits its environment and accepts authored sources; do not offer it as an innocuous workstation-only preview |
| Dry-run Plan | Runtime qualification without live delegated Environment values | Does not establish that real executable paths, external credentials or network access work |

The path resolver checks root/project traversal and real paths, but an authorized
Shell command still runs with its OS account's broader permissions. The Trial
compatibility check verifies declared Environment values, not installed tools,
network connectivity or external permissions
([compatibility](../../packages/trust-runtime/src/trial/service.ts#L86)). The
Trial registry is diagnostic, memory-only and lost on restart; its capacity is
not a limit on active subprocesses
([registry](../../packages/trust-runtime/src/trial/registry.ts#L4)).

## Revocation and departure journey

1. Disable the individual transport credential and terminate its active tunnels,
   sessions and streams. A gateway that checks credentials only on connection
   establishment must also close existing connections. A shared Basic password
   requires rotation for everyone; it cannot identify one departing user.
2. Where future runtime authorization is introduced, revoke that principal's
   resource/capability grants and reject new admissions and authoring calls across
   every protocol. The current runtime has no equivalent per-person revocation
   surface in the inspected paths.
3. Revoke external provider credentials on the execution host/provider and stop
   its authorized worker processes where appropriate. Admission already handed an
   Operation and values to a Runner; closing central access cannot recall an
   external action already running. Do not invent a generic cancellation guarantee.
4. Preserve Plans, Facts, Snapshots and published definitions. Transfer ownership
   of shared Environment/catalog administration, remove obsolete secrets under an
   explicit procedure, and avoid deleting shared resources merely because one
   workstation leaves. Environment names are not user accounts.
5. Verify revoked access through MCP, RPC, telemetry, streams and executable
   server capabilities; separately reconcile any interrupted external action.
   Retrying after unknown outcome follows the Operation's existing safe replay or
   reconciliation rules, not an assumption that revocation undid its effects.

## Extensions and notification operation

Extension manifests currently grant `plans.read` and `plans.subscribe`. Plan
projections are filtered to the installation's Environment, and credential
variables are deliberately selected for the child process. Those are useful
capability boundaries, but the executable module still runs under the host's OS
account and can access resources outside SDK calls. Separate sensitive extension
execution at the OS/deployment boundary if required; the manifest is not a sandbox
([manifest](../../packages/trust-runtime/src/extensions/manifest.ts#L74),
[host process](../../packages/trust-runtime/src/extensions/host.ts#L115),
[scoped reads](../../packages/trust-runtime/src/http/extensions.ts#L69)).

General Plan SSE currently has shared visibility. Extension SSE has installation
scope. MCP SSE signals tool-list changes when extension tools change; it is not a
notification inbox for individual users
([extension stream](../../packages/trust-runtime/src/http/extensions.ts#L108),
[MCP stream](../../packages/trust-runtime/src/http/mcp.ts#L87)). Plan events retain
at most 1,000 entries in memory, with resync after a cursor gap or generation
change. Clients must reread after restart and tolerate disconnection. No email,
mobile push or durable per-user unread delivery is established by these paths.

## Backup, recovery and availability

Back up the **installation's consistent state**, not only its SQL database:

- Core SQL state, including immutable definitions, Plan revisions, Facts,
  Snapshots, identity sequences and stored configuration/credentials.
- Operation catalog files, with their exact bytes and a manifest of expected
  published identities/digests.
- Required private deployment settings, extension installation/configuration and
  separately persisted external extension data, protected according to their
  contents. A coordination extension's database is an external system, not
  automatically part of the core SQL backup.

Publication spans Operation files and SQL, so a database-only snapshot can omit
required executables. Establish a short maintenance/quiescence procedure for
changes across those stores and record the backup boundary. The existing SQLite
import archive is migration evidence, not ongoing target-engine recovery.

PostgreSQL offers SQL dumps, filesystem backup and continuous archiving with
different tradeoffs ([official backup documentation](https://www.postgresql.org/docs/current/backup.html)).
Choose a documented method and retention from the required recovery point/time;
this report does not set those business tolerances. PGlite exposes `dumpDataDir`
and `loadDataDir`, but the runtime does not expose a general backup service using
them ([PGlite API](https://pglite.dev/docs/api)). Neither storage choice makes a
live copy of arbitrary files a proven coordinated backup.

A recovery procedure should restore into an isolated target, compare identifiers,
counts, immutable digests and Operation files, then validate public catalog/Plan
reads and a harmless continuation. Keep one owner: stop the old runtime or prove
its ownership released before the replacement opens that database. PGlite's stale
ownership marker must be investigated rather than automatically stolen. Preserve
semantic authority and verify private configuration without printing secrets.
Reconnect clients and require event resync. Reconcile pending or unknown external
actions; do not automatically replay every in-flight command after restoration.

The present runtime is a single service failure domain. PostgreSQL storage may
have its own managed backup/recovery facilities, but that does not establish
runtime high availability. Graceful shutdown exists; owner loss fails database
work closed. Readiness must reflect that failure: the current `health.read()`
can still say `ok` because it only reads the clock. An operator needs process
supervision, usable startup/owner-loss diagnostics and a documented restart path
before relying on the installation operationally. No restart, recovery drill or
availability claim was performed in this study.

## Bounded load and backpressure

There are useful local limits: PostgreSQL uses eight pool connections plus its
owner connection and a five-second connection timeout; PGlite serializes access;
RPC/OTLP bound individual request bodies; Shell bounds output and duration; events
and Trial diagnostic records have finite retention. Same-composition governance
transactions take advisory locks while independent roots may progress separately
([transaction](../../packages/trust-runtime/src/plan/transaction.ts#L4),
[PGlite queue](../../packages/trust-runtime/src/database/pglite.ts#L57),
[Shell bounds](../../packages/trust-runner/src/shell/run.ts#L38)).

These are not a total service capacity guarantee. RPC batch execution uses
`Promise.all`; a body limit does not supply an explicit batch item/concurrency
limit. Pool size does not bound waiting requests, and the inspected database
configuration supplies no query or lock-wait timeout. PGlite's waiting queue has
no explicit capacity. Trial record eviction does not cap live subprocesses. A
shared installation needs deliberate admission/concurrency limits, bounded waits
and clear overload responses across these paths, preserving progress for read
and notification traffic. Set limits from measured target-host behavior; this
study supplies no throughput number or load-test result.

## Future public acceptance work

These are proposed scenarios, not tests executed by this study.

| Journey | Required public observation |
| --- | --- |
| Two workstations, one runtime | Both read shared state; each Runner executes only its intended local repository path; Facts and subsequent central reads agree |
| Authenticated ingress | MCP, Runner RPC and exact-path OTLP reach the same instance through the selected transport; no direct-backend bypass; TLS and URL errors are clear |
| Distinct rights, if selected | Unauthorized catalog/Environment edits, Plan access, server Trial and extension commands fail across RPC and MCP, including batch requests |
| Credential isolation | Ordinary Environment listing and responses contain no external secret; credentials reach only the intended execution capability; absent permission fails without false qualification |
| Revocation | New calls and existing streams/tunnels are denied/disconnected for one principal without denying others; an already running external action is reconciled explicitly |
| Notifications | Reconnect, cursor gap and restart lead to authoritative rereads; authorized users cannot subscribe to forbidden Plan scopes |
| Extension operation | Declared grants and Environment scope hold; stop/start failures are visible; undeclared SDK access is refused; OS isolation is checked separately where promised |
| Restore | Isolated SQL plus Operation restore preserves public history and identity; one owner opens the target; harmless continuation and next sequence values remain correct |
| Owner loss and restart | Database loss becomes non-ready, work fails closed, old owner cannot continue writing; replacement starts only after ownership is available |
| Overload | Bounded RPC batches, active Trials, lock waits and queues reject excess work clearly while legitimate reads/notifications remain usable |
| Catalog change during backup | Coordinated snapshot contains every referenced Operation; recovery rejects an incomplete artifact set instead of silently proceeding |

## Decisions and evidence limits

The remaining owner choices are: whether participants share full runtime trust or
need distinct roles/resource scopes; which Operations may execute centrally; and
acceptable recovery point/time. Local Runner execution is the recommended default
for workstation repositories. These choices do not require a multi-runtime design.

Evidence is from current source/configuration/document reads in the shared main
checkout on 2026-09-25. Code Moniker supplied focused callable/reference evidence
for extension hosting and Runner orchestration; these bounded extracts are not a
complete architecture graph. No functional tests, intrusive network probes,
accounts, permissions, services, secrets, deployment settings or retained data
were changed. Remote connectivity, identity policy, recovery and capacity remain
unvalidated until their public acceptance journeys run under separate authority.
The only runtime writes for this study are its authorized coordination claim and
response transitions. The coordinator independently reviews and observes completion.

The required static `code-moniker check . --report` gate completed with zero
violations across 688 scanned files. This is architecture qualification, not
behavioral evidence for the proposed deployment.
