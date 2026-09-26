# Shared extension access verification

The owner-approved model on 2026-09-26 is one exact general-use permission per installed extension: `trust.extension.<canonical-id>.use`. It authorizes that extension's own functions and data globally. For example, `trust.extension.coordination.use` permits coordination mission reads and tag edits; it grants nothing on mobile-companion. There is no wildcard, per-command extension permission catalog, extension-object ownership model, or identity inferred from agent labels.

The replacement mission is `abac-access-extension-access-v2-20260926`, Procedure `agent-delegation@1.1.0`. The earlier supplemental mission remains historical and unqualified because its instructions described the superseded per-action model. Existing core ownership missions retain their historical verification evidence.

## Implementation boundary

- The central access authority recognizes only the exact extension-use grammar and checks the verified request context. The installed host resolves the canonical extension identity; caller-supplied command arguments cannot select a different authority. HTTP custom commands, extension API reads and custom MCP tools pass through the same host enforcement.
- A separate canonical SDK `ExtensionInvocationContext` reaches each child hook as its second argument. It contains the verified external principal, installed extension ID and expiration, or an explicit local-mode variant. It contains no bearer, client secret, Plan ownership snapshot or mutable current-user singleton. The child validates and freezes the private IPC projection. A projection cannot be reused as a minted server `AccessContext`.
- Extension-owned event streams require the exact use permission and revalidate it at the idle heartbeat. Plan-bearing events also require installation Plan grants and the current caller's independent core Plan read permission and creator scope. The extension Plan/episode bridge retains those independent checks and installation-environment filtering.
- Extension catalog/status and lifecycle, credentials, publication and every core Plan action remain separate permissions. In particular, extension use does not close a Plan or start an extension. Extensions continue to store their existing global data; coordination and mobile SQL schemas and backend data semantics are unchanged.
- Static bundle delivery and authenticated browser transport are owned by the parallel UI mission. The old duplicate asset-serving branch was removed so that there is one confined static-asset handler. Trusted installed extension JavaScript executes in the host browser realm; this is not a sandbox boundary.

## Named evidence

| Layer | Exact named assertion | Coverage |
| --- | --- | --- |
| Unit | `EXTENSION-ACCESS closed actions and trusted context refuse forged authority` | Exact permission identity and syntax, no wildcard/core/lifecycle implication, forged server-context refusal, IPC identity/expiry validation and explicit local behavior. |
| Integration | `EXTENSION-ACCESS real child HTTP and MCP isolate principals and resource permissions` | Actual runtime, maintained development OIDC provider and installed extension child processes; real coordination/mobile commands and global data; missing or other-extension permission denial; independent catalog/lifecycle/credential/publication/core Plan controls; own Plan filtering; twelve interleaved identities through a disposable context-probe child; input cannot override context; event delivery after a sixteen-second idle heartbeat and no unauthorized Plan payload. |
| Database | `EXTENSION-ACCESS actual extension stores preserve allowed changes and deny foreign mutations` | Runs with both PGlite and PostgreSQL core stores and real PostgreSQL extension stores. A wrong-extension credential leaves tag/response rows unchanged. Authorized global tag edits and competing form responses persist across explicit stop/start of disposable child processes, without adding ownership columns. |

The files are `packages/trust-runtime/acceptance/access-extension-access-{unit,integration,database}.test.mjs`; the shared fixture is `access-extension-access-support.mjs`. The database test's fixed historical name uses “foreign mutations” to mean requests carrying another extension's permission. It does not claim principal ownership of extension data: that concept was explicitly rejected for this version.

All three worker verification Checks and all three independent review Checks completed with an explicit `VALIDATED` verdict on frozen sources and artifacts. Each group executed its exact named assertion once, with zero failed, skipped, crashed, missing or stale assertions. The owner explicitly authorized the unit-group exception for this ABAC mission. Runtime compilation and legacy public extension regression checks also passed under coordinator ownership.

| Group | Worker attempt | Independent review attempt | Matching source/artifact digest |
| --- | --- | --- | --- |
| Unit | `bdaddbdd-ab5c-4df4-a77a-4e363bad0d41` | `8af8e0fb-cbd0-4bd2-a2cb-3f4ce2660beb` | `51ad28a8ef662019ccfc07d2c6caf0ebefe19c6c9fb226b7f583e8e13a520fdb` |
| Integration | `fdb73c29-68d7-4e63-a59a-4b59aac7ba4c` | `892b24ba-f0d5-448f-a3ca-35b9b8d6ea56` | `b931422221bff7b349da3d80d9c0cd07393a9b008685f026ac55728791df6c6d` |
| Database | `a79e619e-e1e2-4488-a1a5-674485f56691` | `91fd06a6-56a0-43e5-8b27-ca1473ac16f6` | `8f923eb11a1212dbcd30c6000b3402b2ff6e4b3daef34ea7c0b1028a8f6205c9` |

Response submission completed with `VALIDATED` verdict (attempt `6e8c9721-557d-4703-9cf8-9538aeddf80c`). The independent final observation also completed with `VALIDATED` verdict (attempt `187a04a5-5e0f-4c87-9054-4f16965d2542`); the mission is `COMPLETE` at revision 12 with all ten Checks satisfied. These results do not claim retained-server activation, deployment, commit or publication.

## Resource and evidence limits

Every fixture creates random disposable runtime and extension stores. Coordination fixture setup invokes its maintained mission-creation function only in that disposable database; it never edits the live delegation runtime or its coordination store. Mobile records and mutations use real public extension APIs. Tests neither reset retained databases nor activate shared authentication on retained servers. PostgreSQL credentials stay in the normal private environment and are not placed in registry URLs or reports.

The fixture exports `createExtensionAccessFixture(kind, { browserOrigin })` for the UI worker's browser journey. Its disposable `dragon-heist` identity probe exercises the real host/child IPC boundary; it does not claim functional coverage of the shipped dragon-heist domain. Actual coordination and mobile child bundles provide the functional workflow evidence. Browser verification, static-module loading and UI credential behavior belong to the separate UI evidence group.
