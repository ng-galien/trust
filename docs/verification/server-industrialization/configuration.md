# Server configuration delivery

The replacement mission is `trust-server-configuration-v3-20260926`; its expanded immutable closure includes executed manifests, build inputs, Desktop/shell and packaged artifacts. The original and v2 missions remain superseded history, not completed deliveries. The final closure contains 119 source paths and 15 artifact paths, including the maintained coordination SQL copied by the real image build.

The implemented startup contract uses one canonical SDK type, strict resolver and file-input schema. Runtime, common shell, Desktop and Runner CLI/MCP consume it directly. Environment overrides file; defaults are last. Shell child launch preserves selected paths and semantic authority, including raw IPv6 bind hosts and bracketed URL authorities. Configuration is inspectable through redacted local CLI reports with provenance. Authentication's previous dedicated file selector is retired with migration guidance.

Operator instructions and every file/environment/default mapping are in [server configuration](../../reference/server-configuration.md); [the inventory](../../architecture/server-configuration-inventory-2026-09-26.md) records the initial state and separates process startup, existing live updates, extension configuration and development harness settings. Local/shared examples are in `assets/configuration`.

## Public evidence

The three exact named assertions are implemented under `packages/trust-runtime/acceptance`:

| File | Exact assertion | Boundary |
| --- | --- | --- |
| `server-configuration-startup.acceptance.test.mjs` | `CONFIG-STARTUP real server validates file and environment configuration` | Real shell/runtime/packaged Runner CLI configuration reports and server startup; precedence/default/provenance, errors and secret redaction, supported timers, retired selectors, retained SQLite refusal, real IPv6 loopback health. The Procedure calls this the unit group; it contains no unit tests. |
| `server-configuration-transport.acceptance.test.mjs` | `CONFIG-TRANSPORT configured server preserves HTTP auth and extension behavior` | Configuration-file-launched shell/runtime, maintained OIDC provider and actual coordination/mobile children; HTTP/MCP use, foreign Plan denial, extension-scope denial and permitted mutation; externally selected semantic authority. |
| `server-configuration-storage.acceptance.test.mjs` | `CONFIG-STORAGE effective configuration preserves database ownership and runtime updates` | Both real PGlite and PostgreSQL targets, actual competing runtime ownership refusal, unchanged live values after file edit, restart persistence, existing Environment and credential updates, original Plan URIs retained and newly engaged Plan authority updated. |

The first local pass ran all three successfully with no skips in approximately 49 seconds. A later strengthened storage assertion incorrectly expected a retained Plan's persisted Check URI to change after restart; its failure identified a test assumption, not a storage defect. The corrected assertion preserves old Plan URIs and verifies the new authority on a newly engaged Plan. Final local replay passed all three assertions with zero failures or skips in 60.91 seconds: startup 18.29 seconds, storage 30.85 seconds, transport 10.31 seconds. The startup group includes real IPv6 loopback binding with an explicit DNS semantic authority, early refusal without that explicit authority, exact canonical authority validation and an environment-over-file Runner path-array assertion. All three governed worker Checks and all three independent review Checks subsequently completed with explicit `VALIDATED` verdicts. Each exact named assertion executed 1/1 with zero failed, skipped, crashed, missing or stale assertions. Before/after and worker/reviewer digests matched for each group.

Compilation of SDK/runtime/shell, Runner typecheck, packaged Runner production and dependency-alignment validation have passed. Compilation is not behavioral evidence. Only owned configuration files were formatted. Historical ABAC tests had their canonical parser imports/file shapes updated; no unit tests were executed for this new configuration work.

## Limits and status

No retained runtime, database or identity provider was activated or modified. Configuration does not introduce reload, extra Plan permissions, a credential-bootstrap bypass, runtime pooling settings, a new migration framework or multi-runtime support. The transport fixture uses an explicitly isolated development issuer; the Helm worker owns strict shared-profile HTTPS and container evidence. Extension databases in that fixture are real disposable PostgreSQL stores; PGlite/PostgreSQL labels refer to the core database adapters.

One runtime per database remains required. Health proves initialized process availability, not continuous database/provider readiness. File edits apply on restart; existing public resource update operations retain their normal immediate behavior.

The final v3 mission has completed its six governed verification/review Checks under the shared source/artifact freeze. Response submission completed with a `VALIDATED` verdict (attempt `5de55e66-b0db-4969-82c7-8610e5d92075`). The coordinator's final observation also returned `COMPLETED` with `VALIDATED` verdict and `next: COMPLETE` (attempt `7b2000ef-7023-407b-b288-ad8c4e7547bd`). Mission `trust-server-configuration-v3-20260926` is **COMPLETE**. Sources and artifacts remain frozen while the separate Helm review finishes. No commit, publication, cluster installation or deployment is claimed here. Container rendering/build/start and Helm package evidence belong to the parallel Helm report.


## Governed verification record

| Group | Worker attempt | Independent review attempt | Matching frozen digest |
| --- | --- | --- | --- |
| Public startup (unit-labelled) | `9d5e289e-0bec-4d8e-8ec2-68de6a298538` | `5bcc594c-48b1-4a4a-9b8d-424a9230b501` | `ef5f56854a869a323b715f96e14ebe05ab0842dfe3ad7718bbe94ecfcbfbec1f` |
| Transport integration | `df3a7593-3469-4d12-bbd7-77a9cd12ee52` | `8d9a888f-3f12-441c-b4a5-fae17d99cfe2` | `83258997beff964eba553f2ace17659dd9837da0b25af758e31febf9248d0422` |
| Database | `a7f24aa8-43ea-4a87-89d7-cf6a8288858e` | `db5d025b-a047-4020-8252-c9bdfbfc118b` | `6dfb4c77fe9a244943cf403920fbb4e0c902fd48856037a09b47e7301fee6abb` |

Each report binds the exact assertion, its real process execution and the complete frozen closure. The canonical authority validation moved unchanged to its SDK owner so startup and Check URI construction share one grammar. The unit-labelled group remains actual CLI/server acceptance, not unit tests.
