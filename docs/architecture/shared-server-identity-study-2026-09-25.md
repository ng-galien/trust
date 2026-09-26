# Shared server: identity and authorization study

Date: 2026-09-25. Status: study and proposed choices; no implementation or activation.
Mission: `shared-server-study-identity-20260925`.

## Outcome and scope

Multiple workstations can be clients of one central TRUST runtime without becoming database owners. The identity gap is at the application boundary: the inspected runtime has no authenticated person, agent, workstation or Runner principal attached to requests. It implements substantial Plan admission, revision, Fact and qualification controls, but these answer whether a Check can proceed, not whether this caller may act. An optional shared password protects the compiled web host; it does not establish individual identity inside TRUST.

The smallest useful team design is one runtime per database, individually revocable client access, a server-derived actor context, and a short list of permissions applied consistently to every public surface. The product owner still needs to choose whether all members share visibility and whether agents act under a human's restricted delegation or as independent service identities. A trusted-team access gate is a smaller operational option, but it cannot be described as individual authorization or verified agent attribution.

This study concerns identity, attribution and permissions. It does not propose multiple runtime owners, workstation database synchronization, a SaaS tenant system, an organizational directory, or a new execution engine. It does not establish which current ports are reachable from another machine. Existing local changes, including quiz work, were preserved.

## Evidence and method

The sources below are the current shared checkout, not a claim about which code is loaded by retained services. Line references identify inspected code as of this study and may move with concurrent edits. No tests, requests against application security boundaries, account changes, configuration changes, service restarts, or retained-data mutations were performed. Public coordination claim/declaration/response transitions on the designated runtime are the only operational writes in scope.

Code Moniker Review posture supplied structural evidence. `workspace.status` returned generation 5, fresh, producer 0.12.0, 685 files, 41,356 symbols and 84,499 references. Bounded `symbol.graph` queries inspected `server.ts`, `http/app.ts`, `http/mcp.ts`, `extensions/host.ts` and `credential/service.ts`, with `consistency:refresh-if-stale`. The extension host's seven reported incoming callers include the HTTP and MCP adapters and runtime composition. The credential service's four reported incoming references are dependency fields in environment/configuration/RPC/runtime composition. Graphs contained unresolved references; absence claims below therefore also use direct source inspection, not an assumption that the index proves no dynamic caller exists. A project-wide architecture gate is coordinated by the parent; this document is not behavioral acceptance evidence.

## What currently identifies whom

| Subject | Existing evidence | What that establishes | What remains absent |
| --- | --- | --- | --- |
| Human using compiled web/mobile | Optional Basic username `mobile` and one configured password; constant-time digest comparison ([shell server](../../packages/trust-shell/src/server.ts#L212), lines 219–288) | Possession of the shared web credential when enabled | Individual account, role, human identity in runtime calls, per-person revocation |
| MCP client / agent | `initialize` validates `clientInfo.name/version`; dispatch receives body, protocol version and services ([MCP](../../packages/trust-runtime/src/http/mcp.ts#L69), lines 69–167 and 1101–1116) | Protocol compatibility and asserted client metadata | Authenticated person/agent, client registration or delegated identity |
| CLI/workstation | Configured HTTP endpoint; JSON-RPC request has content type and body ([shell RPC](../../packages/trust-shell/src/rpc-client.ts#L33), lines 33–43) | Selected destination and request correlation | Device enrollment, device credential, workstation/user binding |
| Runner | Random attempt key, runtime admission handle/execution ID, Check URI and expiry ([Runner](../../packages/trust-runner/src/check/run.ts#L59), lines 59–105) | Execution-attempt correlation | Authenticated Runner installation or authenticated owner of the attempt |
| Plan Session | ID, Plan slug, state, opened/expires/closed times ([model](../../packages/trust-runtime/src/model.ts#L128), lines 128–137; [store](../../packages/trust-runtime/src/session/store.ts#L15), lines 15–25) | Plan execution window | Login session or actor identity |
| Mission assignee/owner | Input actor compared to the mission's assignee/owner ([coordination SQL](../../environments/trust-test/manifests/postgres/002-missions.sql#L60), lines 60–97) | Consistency of asserted agent names under a trusted host | Authentication of the named agent; authorization derived from verified credentials |
| Publisher | RPC writes `local-operator`; MCP writes `mcp-agent`; registry writes `registry:<source>` ([RPC](../../packages/trust-runtime/src/http/rpc.ts#L651), [MCP authoring](../../packages/trust-runtime/src/http/mcp-authoring.ts#L249), [registry](../../packages/trust-runtime/src/registry/service.ts#L200)) | Route/source attribution | Identity of the person who published or authorized synchronization |
| Mobile article author | `author` is a bounded string in the command arguments ([mobile server](../../extensions/mobile-companion/server.mjs#L560), lines 560–579) | Client-supplied editorial attribution | Verified author or verified on-behalf-of relation |

The coordination schema explicitly documents that actor values correlate trusted-host agents and are not authentication credentials (lines 22–23). Its functions run as the database caller, not `SECURITY DEFINER`. A database login can authenticate the external action's database client without authenticating the human or agent string carried in the JSON payload. These are separate trust relationships.

Plan intent is also not a credential. Admission compares the requested text with current intent and reserves an Attempt ([runtime](../../packages/trust-runtime/src/plan/runtime.ts#L1439), lines 1439–1499). A correct current intent means the request follows the Plan's execution sequence. It does not establish the requester's identity, and Plan reads expose that intent to callers.

## Surface inventory: existing, reinforce, absent

### Runtime HTTP, RPC and MCP

**Existing:** one application mounts health, RPC, MCP, live OTLP, diagnostics, Plan events and extensions ([app](../../packages/trust-runtime/src/http/app.ts#L14), lines 14–34). RPC/MCP validate message shapes and dispatch to runtime services; MCP enforces accepted media/protocol versions. **Absent:** a principal-producing authentication middleware or permission context in these handlers. RPC dispatch receives the request body and dependencies ([RPC](../../packages/trust-runtime/src/http/rpc.ts#L811), lines 811–834); MCP dispatch receives body, protocol version and dependencies. Consequently a network-admitted caller is not split into reader, editor, executor and administrator by these adapters. Domain preconditions still apply.

**Reinforce:** use one authorization policy across RPC and MCP. Hiding a tool from an MCP list or removing a web button cannot protect the corresponding RPC method. Filter discovery for usability, but enforce the decision when the service action executes. Cover health detail, diagnostics, SSE and WebSocket upgrades as deliberately as POST routes. The direct runtime `/lsp` WebSocket is mounted separately and receives catalog access without a caller context ([server](../../packages/trust-runtime/src/server.ts#L155), lines 155–169).

No Origin validation was found in the inspected runtime HTTP/MCP/server path. This is a distinct browser-origin boundary, not a substitute for identity. It needs a deliberate allowed-origin policy when a shared entry point is introduced. No browser exploit was attempted, and no claim is made about external proxy protections.

### Compiled web host and mobile gateway

**Existing:** the password, when present, gates every compiled-web HTTP request and upgrade; absent configuration permits requests. Passwords shorter than 20 characters are rejected at startup ([shell](../../packages/trust-shell/src/server.ts#L96), lines 96–102). Basic authorization is removed before forwarding, so the runtime receives no authenticated human identity from this gate (lines 295–315, 331–352). Mobile upstreams are selected from configured loopback origins; requests cannot select an arbitrary target (lines 37–81).

**Absent:** per-person authorization and verified forwarding of an actor. The shell proxy path list is `/health`, `/rpc`, `/mcp`, `/otlp`, `/events`, `/extensions` (line 19); the live Fact endpoint `/v1/traces` is not in that list. A shared-server design must deliberately route and protect the Runner's RPC and live OTLP endpoints together. Simply pointing a Runner at the browser origin does not establish complete current endpoint coverage.

**Reinforce:** choose a canonical trusted entry point and prevent ordinary clients from bypassing it via the direct runtime or extension backends. Authenticate browser sessions at that point, apply CSRF/origin protections to cookie-authenticated writes, and reject client-supplied identity headers before adding verified identity. Preserve separate identities when proxying mobile applications. The existing gateway rewrites Origin/Referer for mobile upstreams (lines 313–315, 348–351); those rewritten values do not identify a user. The mobile README explicitly calls the current password a one-operator gate and says Vite dev/preview lacks it ([README](../../extensions/mobile-companion/README.md#L186)). This study did not inspect a live Tailnet ACL or an upstream application's login policy.

### Runner, Fact ingestion and external permissions

**Existing:** admission checks Check existence, escalation state, dependencies, re-observation rules and Session availability ([runtime](../../packages/trust-runtime/src/plan/runtime.ts#L1367), lines 1367–1410). Live admission returns the compiled Operation and its declared Environment values; dry-run returns no Environment values (lines 893–912). Fact ingestion checks the attempt key, execution ID, Check URI, expiry, open Session, current intent ownership, compiled Check and Produced schema (lines 937–995). These are useful integrity controls to retain.

**Absent:** a verified Runner principal and binding of the lifecycle calls to it. Runner RPC and OTLP clients supply content-type/accept headers, not authentication ([client](../../packages/trust-runner/src/check/client.ts#L60), lines 60–68; [exporter](../../packages/trust-runner/src/telemetry/otlp.ts#L38), lines 38–45). OTLP attributes include attempt correlation and a `service.name` string; the parser extracts correlation and Facts without authenticating the producer ([OTLP](../../packages/trust-runtime/src/http/otlp.ts#L62), lines 62–81). `trust-runner` is an asserted service label, not attestation. An accepted Fact is validated against its contract, not independently proven to be a truthful observation of an external action.

**Reinforce:** authorize admission before returning Environment values; bind the Attempt to the authenticated executor/delegation; require that authority for OTLP ingestion, finalization and interruption. Treat possession of an attempt handle as correlation, not standalone authorization. Preserve legitimate same-attempt replay while rejecting use by another principal. Decide explicitly whether a nominated replacement Runner may resume an admitted Attempt.

Actual external access remains the Runner process's responsibility. It runs on the invoking workstation for ordinary Checks; CLI startup selects RPC/OTLP endpoints and passes its local environment to execution ([CLI](../../packages/trust-runner/src/cli/run.ts#L36), lines 36–45). Shell subprocesses inherit the process environment except `TRUST_*` and `JIRA_AUTHORIZATION` ([shell execution](../../packages/trust-runner/src/shell/run.ts#L157), lines 157–168). Identity in TRUST would therefore authorize obtaining/executing a Check; it would not replace the external service's own user, database or cloud permissions, nor prove which physical workstation produced a Fact.

The current credential store must not be mistaken for a login service. Its public list returns Environment/name references only, and save/remove operate on external configuration ([credential service](../../packages/trust-runtime/src/credential/service.ts#L25), lines 25–61). The inspected live admission resolves ordinary Environment values, not `CredentialService.resolve`. No such resolve consumer was found in the inspected call paths. Ordinary Environment listing returns the value map ([environment service](../../packages/trust-runtime/src/environment/service.ts#L26), lines 26–34). Preserve that distinction; do not claim all stored credentials are currently injected into every Runner.

### Server-side trials are a separate execution privilege

**Existing:** `operation.trial.start` accepts either an Operation identity or caller-provided source, an Environment and inputs; it records `startedBy: local-operator` ([trial RPC](../../packages/trust-runtime/src/http/trial.ts#L43), lines 43–69). The service compiles source if supplied and spawns the packaged Runner on the runtime host, inheriting `process.env` ([trial service](../../packages/trust-runtime/src/trial/service.ts#L179), lines 179–205). These are execution paths, not harmless validation/read calls.

**Reinforce:** separate permission to run a trial on the server, including Environment and host execution policy, from permission to compile or edit source. Otherwise granting an agent authoring access also grants access to a central-host execution surface. This is a source-established capability, not an attempted exploit. Trial cancellation and diagnostic reads also need ownership/scope rules. Diagnostics currently append by trial ID and stream by ID without a principal ([diagnostics](../../packages/trust-runtime/src/http/diagnostics.ts#L15), lines 15–75).

### Extensions and streams

**Existing:** installation grants control extension access to Plan reads/subscription, and those reads filter by installation Environment ([extension routes](../../packages/trust-runtime/src/http/extensions.ts#L69), lines 69–147). Declared command names and response envelopes are checked. Child processes receive only selected environment variable names plus PATH/SYSTEMROOT ([host](../../packages/trust-runtime/src/extensions/host.ts#L50), lines 50–84, 115–149). These are real installation boundaries.

**Absent:** end-user/agent authorization inside those boundaries. Lifecycle routes and declared command invocation have no caller identity (extension routes lines 15–45); installation permission is not permission for every user of an installation. The SDK context contains configuration, Environment and change publishing; command/read inputs are unknown payloads with no trusted actor channel ([SDK](../../packages/trust-extension-sdk/src/extension.ts#L1), lines 1–14). The Node child process is not an OS sandbox; its privileges and configured database credentials remain trusted installation authority.

**Reinforce:** intersect installation capability with the calling principal's permitted resources/actions; pass a separately derived trusted context to extensions, never an editable `actor` argument. Apply the same decision to HTTP and MCP extension commands. Review mobile write commands individually: `readOnlyHint` describes tool behavior, not access control ([host](../../packages/trust-runtime/src/extensions/host.ts#L206), lines 206–229). Core Plan SSE replays and subscribes without filtering by viewer ([events](../../packages/trust-runtime/src/http/events.ts#L9), lines 9–33). Resource-specific access would need filtering of list, history, search, counts, subscriptions and reconnect replay, not merely individual Plan reads.

## Proposed minimal permission matrix

The matrix is a product proposal, not an implemented role catalog. “Scoped” means a server-enforced grant; Environment or Plan labels are not automatically an authorization namespace. Start with one team-wide resource boundary if all members may see all work. Add project/Plan isolation only if the owner chooses it.

| Action family | Current non-identity guard | Reader | Operator / delegated executor | Author / publisher | Administrator |
| --- | --- | --- | --- | --- | --- |
| Read catalog, Plan, Check, Session, history; subscribe | Shapes, existence, pagination; extension Environment filter | Scoped read | Scoped read | Scoped read | Read |
| Engage Plan; replace declarations / accept missions | Closed inputs, revision and append-only mission rules | No | Explicit Plan-management grant | Separate grant if needed | Explicit grant |
| Admit live Check; ingest Facts; finalize | Dependencies, Session, intent, Attempt and Produced schema | No | Permitted Check + Environment; lifecycle bound to executor | No by default | No automatic external-execution right |
| Dry-run facts / re-observation | Dry-run mode and Check rules | No | Dedicated dry-run grant | Optional scoped grant | Explicit grant |
| Escalate; close; resume; reset/remove dry-run; interrupt | State, revision and mode restrictions | No | Escalate own work; supervisory operations separately granted | No by default | Supervise scoped work |
| Compile/simulate source without executing external actions | Grammar/type checks | Optional | Optional | Yes | Optional |
| Publish executable Operations/Procedures; registry sync | Immutable versions/digests and compatibility | No | No by default | Explicit publishing grant | Configure trusted sources |
| Edit catalog presentation/templates | Revision checks | No | No by default | Editorial grant separate from executable publishing | Yes |
| Execute/cancel server-side Operation trial | Source/input/Environment validation and timeout | No | Only explicit server-execution grant | Authoring alone insufficient | Separate grant and host policy |
| Read ordinary Environment values / credential names | Configuration shapes | Explicit configuration-read only | Only required execution values | Explicit configuration-read | Yes |
| Save/remove Environment or credential; registry configuration | Name/schema validation | No | No | No by default | Yes |
| Extension prepare/start/stop; mobile writes; notifications | Installation state and declared command | Read if allowed | Per-command/resource grant | Per-command grant | Lifecycle administration |
| User/client enrollment; revoke access | Not implemented | No | No | No | Yes |

Do not make administrator membership silently equivalent to permission to execute all external Operations. Conversely, an approved Check cannot override a denied caller permission. Authorization precedes execution admission; the existing Check qualification remains the authority on the Plan's outcome. UI visibility should explain denied actions, but the server decision is authoritative.

## Acting on behalf and attribution

Recommended minimum identity model, subject to product approval:

1. A stable **principal** identifies a human or service account. Display names are editable presentation and never keys for permission checks.
2. A revocable **client credential/session** belongs to that principal or to an explicitly authorized delegated client. Record the credential identifier, not its secret. A workstation label and agent run name remain asserted metadata unless separately enrolled and authenticated.
3. A **delegation** states who authorized which agent/service to perform which actions on which resources, with expiry and revocation. Effective permission is the intersection of current principal rights, delegation rights and extension/Environment constraints. A supplied `onBehalfOf` field cannot create authority.
4. An Attempt and administrative mutation record the verified principal, credential/client identifier, optional verified delegator, request/action/resource and timestamp. Keep asserted agent/model/workstation labels visibly distinct. This proposal adds provenance to existing histories; it does not invent a Proof/Evidence/Binding resource or reinterpret old Fact digests.

For example, “Alexandre authorized agent session X to execute Plan Y using Environment Z until time T” is a verifiable relationship only if the server issues/stores it from an authenticated grant. “actor=Alexandre” inside an Operation input remains a claim. An independent automation service can instead have its own narrow rights and owner; its actions must not be presented as a human's direct action.

Historical `local-operator`, `mcp-agent`, mission actor and article author values must remain historical attribution. Do not retroactively promote them to verified principals or rewrite immutable observations. If authentication is later introduced, show that older records lack verified identity. Authentication itself proves possession/control of a credential, not that a human personally reviewed an action or that an AI-generated observation is truthful.

## Small access options and recommendation

| Option | Delivers | Remaining limitation / cost |
| --- | --- | --- |
| Trusted-team private access gate | One central endpoint reachable only by approved people/devices; minimal operational change | All admitted callers still share runtime authority unless application authorization is added. Shared-password rotation affects everyone; agent attribution remains asserted |
| Individual revocable access + small runtime permissions | Distinct human/service principals, per-client credentials, common service-layer policy, useful attribution and per-client revocation | Requires client authentication support in CLI/Runner/OTLP and trusted browser sessions; product must choose common versus restricted data visibility |
| Standard MCP OAuth access backed by a chosen authorization service | Interoperable user authorization for compatible remote MCP clients; same runtime permission model underneath | More discovery/token/client integration; does not itself authorize RPC, OTLP, extensions or external actions |

Recommend the second option as the minimal **application** capability for a genuinely shared team server. Individual credentials may be backed by an existing trusted access gateway or a small application-owned account store; choose one authority, not two competing actor databases. A gateway can authenticate people, but a gateway-only solution is insufficient if the runtime does not receive a trustworthy identity or if clients bypass it. Manually provisioned per-client tokens are a pragmatic private deployment possibility, not a claim of standards-compliant MCP OAuth interoperability.

The official MCP `latest` documentation resolved to version **2026-07-28** when read on 2026-09-25. Its authorization framework is optional; protected HTTP implementations are directed toward its OAuth model. The documented resource-server flow includes metadata discovery and token audience validation, with invalid/expired access rejected. This is a choice for interoperable MCP access, not an existing TRUST feature. [Official MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

The current Streamable HTTP specification requires Origin validation and recommends authenticating connections. Its security guidance says state handles must not serve as authentication and recommends binding them to verified users. These principles apply to the proposed Attempt binding; TRUST's domain Session must remain distinct from an authentication session. No full MCP protocol conformance audit was performed. [Official transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [official security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#state-handle-hijacking).

## Provisioning and revocation choices

Provisioning should distinguish adding a human, enrolling a human's workstation/client, creating an independent service, and granting a bounded agent delegation. Prefer separate credentials for separate workstations/Runners so a lost device does not require changing every person's access. Browser login should not require putting long-lived machine credentials in URLs or script-visible storage. Selection of authentication technology, secret storage and expiry durations remains open; no credential or account was created in this study.

Revocation should disable the relevant credential or delegation centrally and stop new admissions immediately. Apply current rights again when accepting Facts/finalizing, or explicitly document an alternative admitted-attempt grace policy. End or reauthorize SSE/WebSocket streams after revocation instead of letting an old connection retain indefinite visibility. Revoking a person should cover their clients and delegations; revoking one workstation should not erase the person's history or unrelated credentials. An implementation must define cache invalidation and the maximum delay of revocation.

Revoking TRUST access cannot undo an external operation already executed, terminate a disconnected workstation's process reliably, or retrieve values already delegated. Already-issued external credentials require revocation at their external issuer when appropriate. Preserve received history; decide whether an in-flight Runner can report its outcome after its authority is revoked. Rejecting its report and accepting it through a restricted completion path have different operational consequences and need an explicit product decision. The current Plan close/Attempt expiry mechanisms constrain work but are not substitutes for credential revocation.

## Open product decisions before implementation

1. **Visibility:** does every admitted team member read every Plan/catalog/history, or are some projects/Environments confidential? Do not repurpose existing descriptive labels as ACLs without a decision.
2. **Agent authority:** are agents always delegated by a human, or can service accounts own independent long-running work? Are agent identities durable or scoped to one host session?
3. **Workstation and Runner identity:** is a per-client credential enough, or is separately enrolled device identity required? A machine label alone cannot prove execution location.
4. **Execution permission:** who may obtain admission for each Environment/Operation, and who may execute caller-authored trials on the central host? Does publishing require a different role from execution?
5. **Supervision:** who may close/resume/escalate/intervene in another actor's Plan or pending Attempt? Is there an explicitly audited administrator override?
6. **Revocation:** what happens to in-flight work, accepted Facts, completion reports and open streams when a principal or delegation loses access?
7. **Authentication integration:** private managed clients first, or remote MCP OAuth interoperability immediately? Which one authority provisions humans and verifies identities? Existing network identity is usable only if the runtime can trust its verified propagation.
8. **Extensions and audit:** which identity context is mandatory in the SDK, which commands are allowed to a mobile-only user, and which historic attributions must be displayed as unverified? Decide retention of authentication/audit events separately from immutable execution Facts.

The source review establishes the missing identity and authorization boundaries and the existing integrity controls worth retaining. It does not establish current network exposure, credential contents, security of external accounts, actual client OAuth support, resistance to attacks, or production suitability. Those would require a separately authorized implementation and public acceptance effort.
