# Extension lifecycle and federated integration UI

Status: implementation proposal following the first dogfood delegation. The recovery acceptance is the immediate consolidation milestone. The lifecycle and federation described here are not implemented yet. Explicit product decisions remain authoritative.

## Purpose and ownership

An integration owns its business state, external connections, interpretation and dedicated UI. TRUST owns the Plan/Session/Check execution contract. The application hosts the integration's page without absorbing its domain model.

| Owner | Responsibilities | Excluded |
| --- | --- | --- |
| TRUST qualification engine | Admission, Facts, qualification, cascade, Sessions and intent | Extension schemas, mission statuses, UI-specific aggregates |
| Generic extension host | Configured installation, lifecycle, readiness, route and UI contribution registration | PostgreSQL-specific preparation or qualification decisions |
| Application shell | Generic extension navigation, remote loading, theme/language, error fallback and links to Plans | Knowledge of missions, sprint tickets or integration-specific fields |
| Coordination extension | Mission storage/read API, connection pool, schema preparation and mission view | Writing TRUST SQLite or qualifying a Check |

Current entry points are `packages/trust-runtime/src/server.ts` for the runtime process and `packages/trust-shell/src/server.ts` for the common CLI/Electron deployment. The latter already starts and stops the runtime child process; Electron calls it instead of owning another server implementation. The generic extension lifecycle belongs at runtime process composition, not inside PlanRuntime. Shell and dev proxy paths must expose the same extension surface. No new domain package or import from `trust-legacy` is needed.

## A small explicit lifecycle

Use one versioned manifest, one server module and an optional built UI remote. An installation chooses its configuration and enabled state; merely finding a directory never activates code.

Three extension-owned hooks are sufficient for the first slice:

| Hook | Invocation | Contract |
| --- | --- | --- |
| `prepare` | Explicit operator action while stopped | Establish extension-owned schema/resources, or explain the incompatibility. Repeat-safe for the declared schema; no automatic migration or destructive repair. |
| `start` | Explicit activation, or configured startup of an already prepared installation | Validate configuration and schema, connect, then expose an instance only after readiness. Release partial resources before reporting failure. |
| `stop` | Deactivation or host shutdown | Withdraw new work, finish/interrupt outstanding requests according to the declared bounded shutdown policy, close pools/subscriptions, and release resources. Repeat-safe; never delete data. |

Configuration validation occurs before a hook can cause external effects. A separate `validate` hook is unnecessary if the manifest has a closed configuration schema and the extension validates external prerequisites in `prepare`/`start`.

Activation does not run `prepare` implicitly. Startup must not unexpectedly alter a shared database. An absent or incompatible schema produces a clear preparation-required/error state and no active page/API contribution. As required by the current repository policy, there is no migration framework before release. A later schema-upgrade policy will be a distinct explicit operation, not a hidden start hook.

An extension may legitimately need temporary connections during `prepare`. These must be closed whether preparation succeeds or fails; long-lived pools belong to the running instance.

Stopping one installation does not establish exclusive ownership of a shared database. Two installations can target the same schema, and independent runners may still use it. The first preparation contract should create an absent extension-owned schema or accept an already compatible schema without mutation; an incompatible existing schema must be refused. The extension must serialize competing preparation at the database boundary and verify schema ownership/compatibility there. Per-installation host locks alone are not sufficient. Changing or replacing a live shared schema requires an explicit maintenance decision, not merely a stopped UI extension.

Visible lifecycle states: registered/stopped, preparing, starting, running, stopping, error. Serialize lifecycle operations per installation. A duplicate start must not open a second pool. A stop arriving during startup must not leave a late running instance. Shutdown must attempt cleanup for every started extension even if another stop fails.

No uninstall-data hook in V1. Removing an installation unregisters its code after stopping it; business data remains. Dropping schemas would be a separate destructive operation requiring explicit scope and authorization.

Drain only resources owned by the extension instance. In the current integration, the runner has its own PostgreSQL connection and its own admitted Check attempt. Stopping the read API/UI must neither cancel that independent operation, reclassify its Facts, nor claim that all mission work is drained. Runner admission and qualification remain under TRUST's existing rules. Test extension shutdown while a separate runner operation is in flight.

## Host/extension boundary

The manifest identifies the extension, artifact version, host contract version, configuration schema, server entry and optional federated page contribution. Installation configuration is server-side and never returned in the public UI manifest. Secrets are runtime configuration/credential references, not manifest values, browser props, Plan inputs or telemetry payloads.

The server module receives a deliberately small context and returns its supported capabilities. Do not give it the Awilix container, Express application, TRUST database driver, or unrestricted access to internal services. Public TRUST clients remain the way to read or engage Plans. Registration of HTTP/UI contributions is owned by the host, so a failed extension cannot leave a half-registered route catalog.

The first business API is read-only. The coordination extension can expose a bounded mission listing/detail projection from PostgreSQL. The view separately reads the associated Plan state/intent from public TRUST reads. Database state and TRUST qualification are distinct fields; an extension must not label a mission VALIDATED because its row says completed.

When the UI later offers governed business mutations, those go through the Procedure and runner. A generic extension HTTP handler must not become an alternate unrestricted mutation path around Checks. Lifecycle administration is a separate operator surface from agent execution; adding a page must not automatically add agent MCP tools or credentials.

## Failure boundary to prove before broadening

A browser federation remote shares the host's JavaScript environment. This is a trusted-extension model, not an access-control sandbox. An error boundary handles ordinary render failures, not malicious code or every global side effect.

For server hooks, choose the process boundary explicitly during the first lifecycle implementation. A child process provides bounded termination of a hanging hook and protects the Check process from an extension crash; it does not by itself restrict database or filesystem permissions. An in-process implementation is smaller but cannot honestly promise either crash isolation or forced cleanup of uncooperative code. Do not hide this tradeoff behind a timeout that leaves the hook executing.

Recommendation: a small child-process host for server extensions, with readiness/stop messages and bounded termination, following the established server-process ownership pattern. No generic RPC SDK, hot replacement, plugin dependency graph, marketplace, distributed recovery or shared migration journal in the first slice.

## First UI: real missions and a selected-mission inspector

Visual thesis: the existing TRUST typography and calm surfaces, a readable mission list, and one detailed working area rather than a new dashboard mosaic.

Content plan:

1. Workspace: actual pending/claimed/completed/blocked missions, with project and assigned agent. Filters use existing fields only.
2. Inspector: full instructions, expected result, authorized/forbidden scope and returned response.
3. Execution context: separately labelled Plan state, current intention, latest qualification and a link to the generic Plan/history screens. Missing Plan data stays unavailable rather than becoming an inferred verdict.

Interaction thesis: a clear selected row, a short inspector reveal and explicit refresh feedback; respect reduced motion. No invented percentage, deadline, priority, activity signal or task hierarchy.

The host offers only a generic extension slot and a small context: installation identity, theme, language, integration API base, public Plan navigation/read capabilities. The extension owns its view and local state. Do not transplant the legacy Zustand store factory requirement unless a real shared-state need justifies it.

## Federation qualification

Reproduce the legacy principle, not its SDK or dependency versions. The current application uses Vite 8. The maintained Module Federation Vite integration is a candidate; the exact installed version must be checked and exercised with a built remote before adopting it.

Primary references inspected:

- <https://module-federation.io/integrations/build-tool/vite>
- <https://github.com/module-federation/vite/blob/main/docs/MIGRATING_FROM_ORIGINJS.md>
- Historical implementation: `trust-legacy/state-machine/apps/trust/src/client/plugin-host/remoteModules.ts`, `components/plugin-host/PluginPageHost.tsx`, and `packages/trust-sdk/src/ui/context.ts`.

The boundary test must load the actual emitted remote entry and chunks in the real application, never import the extension page source into the host as a substitute. Verify shared React compatibility, theme/language propagation, disposal on navigation, failed load/render fallback, unavailable backend, and continued access to normal TRUST pages. Validate the common deployed shell as well as Vite development routing.

## Ordered implementation slices

1. Finish worker recovery: a new MCP client with only a Check URI regains the immutable engagement context without replaying a satisfied action; demonstrate red/green at public boundaries.
2. Lifecycle host and a small disposable acceptance extension: explicit preparation, readiness, failure cleanup, serialized activation/deactivation, process shutdown and no data deletion. Verify that core health/Checks remain usable after extension failure.
3. Package coordination as the first real extension: one authoritative SQL schema asset, configurable external PostgreSQL connection and a bounded read API. Keep preparation separate from activation; do not restart or erase the existing dogfood database.
4. Generic UI host plus the independently built coordination remote; verify the actual retained dogfood missions and intentions in the browser, with no integration-specific code in core resource screens.

Retain the runtime acceptance history and align the A3 functional model when Maket MCP is available. These steps do not claim production readiness of the existing PostgreSQL test deployment: it still needs durable storage/backup before ongoing work can rely on it.
