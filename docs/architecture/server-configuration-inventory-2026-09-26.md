# Server configuration inventory and harmonization

Mission: `trust-server-configuration-20260926`. Inventory taken from current production launchers on 2026-09-26, after the completed ABAC extension missions. The owner selected **environment overrides file overrides defaults**. Implementation follows this inventory; startup values require restart unless an existing update surface is explicitly listed below. This document does not report private retained-server effective values.

## Observed startup parameters

All rows are process startup settings, not Plan inputs. Public means non-secret configuration, not an unauthenticated API. File paths and connection targets still deserve normal operational care.

| Owner and source | Parameter | Type/unit and observed default | Validation and visibility |
| --- | --- | --- | --- |
| runtime/index.ts; shell/cli.ts; desktop/main.mjs | `TRUST_HOST` | string, `127.0.0.1` | TCP bind host; public. Shared by shell web/runtime listeners. |
| same | `TRUST_PORT` | integer TCP port, 4318 | Runtime accepts 0–65535; shell/desktop 1–65535; public. |
| shell/cli.ts; desktop/main.mjs | `TRUST_WEB_PORT` | integer TCP port, 4173 | 1–65535, must differ from runtime port; public. |
| shell/cli.ts | `TRUST_SERVER_STATE_DIRECTORY` | directory, `.trust/server` resolved against cwd | Shell requires absolute path after resolution. Desktop instead supplies `<userData>/server`; public. Writable operations and logs even with external PostgreSQL. |
| shell/installation.ts | `TRUST_INSTALL_ROOT` | optional absolute directory; otherwise searches cwd/package ancestors | Must contain compiled runtime/web plus Operations and Runner sources; public. |
| runtime/index.ts | `TRUST_SEMANTIC_AUTHORITY` | authority string, `localhost:4318` | Check URI authority normalization. Shell currently overwrites with bind host/port, losing external authority. Public, immutable for a running process. |
| runtime/storage-configuration.ts | `TRUST_STORAGE` | `pglite` or `postgresql`, default `pglite` | Explicit mutually exclusive target fields; public. |
| same | `TRUST_PGLITE_DIRECTORY` | directory, `.trust/pglite` resolved against cwd | Nonempty. Shell defaults to `<state>/pglite`. Existing legacy SQLite blocks silently opening a fresh default target. Public. |
| same | `TRUST_DATABASE_URL` | PostgreSQL URL, required for selected PostgreSQL | Driver accepts postgres/postgresql. Potential credentials: always redact the complete value in effective reports. No default. |
| same | `TRUST_DATABASE_PATH` | retired SQLite selection | Always rejected, never treated as a migration request. |
| runtime/index.ts; operation/catalog.ts | `TRUST_OPERATIONS_DIRECTORY` | optional directory | Catalog initializes source directory. Shell copies missing bundled Operations into `<state>/operations` and currently overwrites selection. Public. |
| runtime/index.ts; plan/runtime.ts | `TRUST_SESSION_DURATION_MS` | positive safe integer milliseconds, 86400000 | Technical Session lifetime; does not grant permissions. Public. |
| runtime/index.ts; trial/service.ts | `TRUST_TRIAL_TIMEOUT_MS` | positive safe integer milliseconds, 600000 | Trial process deadline; public. |
| runtime/index.ts; trial/service.ts | `TRUST_RUNNER_TRIAL_SCRIPT` | optional script path | Default compiled packaged Runner trial script resolved relative to runtime. Public. |
| runtime/index.ts; server.ts | `TRUST_DIAGNOSTICS_ENDPOINT` | optional HTTP endpoint | Default current runtime origin plus `/otlp/diagnostics`. Shared mode requires runtime origin because verified Trial bearer is forwarded privately. Public URL, never bearer in query. |
| runtime/index.ts; extensions/manifest.ts | `TRUST_EXTENSIONS_FILE` | optional installation JSON path | Absent means no extensions. Manifest paths absolute, confined assets, installed identity/grants/config validated. Public registry must exclude secrets. |
| runtime/runtime.ts | `extensionTimeoutMs` | programmatic positive timeout milliseconds, default 10000 | Current CLI does not expose it; real existing host IPC timeout, not a proposed retry mechanism. |
| runtime/index.ts; logging.ts | `TRUST_LOG_LEVEL` | fatal/error/warn/info/debug/trace/silent, default info | Exact enum; diagnostics only, never governance Facts. Public. |
| runtime/index.ts; logging.ts | `TRUST_RUNTIME_LOG_PATH` | optional path, otherwise stderr | Shell currently overwrites `<state>/runtime.log`. Public path; records redact common secret fields. |
| runtime/index.ts | `TRUST_RUNTIME_INSTANCE` | optional string | Shell generates UUID to recognize its own child health response. Internal launch correlation, not a user identity or policy knob. |
| shell/server.ts | `TRUST_WEB_ACCESS_PASSWORD` | optional secret string, minimum 20 characters | Basic outer web gate, removed from child env; incompatible with shared bearer auth. Entire value redacted. |
| shell/server.ts | `TRUST_MOBILE_UPSTREAMS` | JSON map, default empty | Entries id → `{url,pathMode?}`; only exact `http://127.0.0.1:<port>` origins, mode strip(default)/preserve. Host-selected forwarding, no caller target URL. Public. |
| shell/cli.ts | `TRUST_URL` | optional URL, default shell host/web port | Registry CLI client target, not runtime bind or semantic authority. Public. |

Source locations above are relative to `packages/trust-runtime/src`, `packages/trust-shell/src`, and `apps/trust-desktop/src` as named. No TLS listener, replica count, generic reload, configurable PostgreSQL pool or automatic schema-migration setting currently exists in these launchers.

## Authentication and Runner

`TRUST_AUTH_CONFIG_FILE` currently selects an absolute JSON file. Without it the runtime is explicitly local. Existing file fields have no environment overrides. The wrapper is `{profile,access,browser?,resourceUrl}`. Profile is development/shared; a configured wrapper cannot silently disable validation. Shared refuses insecure development loopback. All values are startup-only; token freshness and introspection happen per the existing access service, not through file reload.

| Field | Type, default and checks | Visibility |
| --- | --- | --- |
| `profile` | development/shared, required in auth file | public |
| `resourceUrl` | required HTTPS URL; HTTP loopback only development | public protected-resource metadata |
| `access.mode` | local-jwt/introspection; required | public operational choice |
| `access.issuer`, `audience` | nonempty identifiers; issuer HTTPS except explicit development loopback | public |
| `discovery` | oidc(default)/oauth | public |
| `clockToleranceSeconds` | integer 0–60, default 0 | public |
| `maxTokenAgeSeconds` | integer 1–86400, default 300; bounds both age and token lifetime | public |
| `timeoutMs` | integer 100–30000 ms, default 5000 | public |
| `allowInsecureLoopback` | boolean, default false | development-only |
| JWT `algorithms` | nonempty asymmetric allowlist, default RS256 | public |
| JWT `tokenProfile.headerType` | default at+jwt; other types require claim discriminator | public |
| JWT `tokenProfile.requiredClaims` | string map, default empty | public |
| introspection `clientId` | nonempty | public |
| introspection `clientSecretReference` | existing `{environment,name}` credential reference | reference public; resolved value secret, never browser data |
| introspection `authenticationMethod` | client_secret_basic(default)/client_secret_post | public |
| `browser` | optional issuer/clientId/redirectUri/postLogoutRedirectUri/scope/resource | public `/auth/config`; issuer must match access, redirects same origin, no client secret |

Runner CLI and MCP stdio currently duplicate endpoint defaults. `TRUST_RPC_ENDPOINT` defaults to `http://127.0.0.1:4318/rpc`; `TRUST_OTLP_ENDPOINT` to `/v1/traces` at that origin. Authenticated Runner requires both exact protocol paths and same origin. `TRUST_AUTH_FILE` points to a private credential file: absolute path, parent/file permissions and owner checked, no symlink; tokens are not accepted from `TRUST_ACCESS_TOKEN`, `TRUST_REFRESH_TOKEN` or `TRUST_AUTHORIZATION`. Refresh atomically updates the private file; no server configuration reload is implied.

`TRUST_RUNNER_LOG_PATH` defaults to `<TRUST_SERVER_STATE_DIRECTORY or .trust/server>/runner.log`; `TRUST_LOG_LEVEL` uses the same enum. Repeatable CLI `--path <absolute-directory>` augments child PATH. `TRUST_SHELL_TIMEOUT_MS` currently reads global process.env at module initialization, parseInt accepts trailing junk and invalid values silently fall back to 600000ms; injected Runner environment does not control this value. Harmonization must validate and pass the effective value explicitly. `TRUST_RUNNER_PROCESS_GROUP=1` is an internal Trial-child process-group marker, not an operator setting. Trial job stdin carries its diagnostics endpoint/authorization privately; never transfer this authorization through the configuration report, argv or environment.

Runner login has a separate explicit `auth.js --config <private-file> --output <private-file>` credential-enrollment contract (issuer/clientId/optional clientSecret/origin/resource/scope/redirectUri). Its 180000ms callback deadline and 30000ms freshness threshold are fixed implementation safeguards, not exposed settings. Enrollment secrets remain outside the common startup file.

## Existing updates and separate domains

Environment values and named credentials persist in the runtime database, initialize caches at startup, and update immediately through their authorized save/remove RPC methods. They remain business Environment/credential resources and are not imported from server startup settings. Plans retain immutable roots and revision-checked declarations; server configuration does not alter them. Registry source save/remove/sync remains explicit. Operation drafts are files under the configured catalog directory; publication semantics remain unchanged.

Extension installation JSON is read at runtime startup, not watched. Each entry selects an absolute manifest, environment, grants, string configuration, credentialEnvironment allowlist, and autoStart boolean. Lifecycle prepare/start/stop works at runtime but does not reload registry definitions. Coordination owns databaseUrl; mobile owns databaseUrl/legacy databasePath and pushSubject/pushAllowedOrigins; dragon-heist owns dataDirectory/trustBaseUrl. These stay extension-specific manifest contracts, not new generic server settings. Child credentials pass only from its declared process-environment allowlist. Extension-use permission does not grant core Plan actions or lifecycle rights.

PostgreSQL driver has a fixed pool of eight plus a dedicated runtime ownership session, fixed 5000ms connection timeout, UTC and fixed search path. One runtime per database is enforced. PGlite is an embedded process-owned store. Neither permits an overlapping multi-runtime deployment. `/health` reports initialized runtime health after startup (503 while initializing); it does not continuously query the database or prove remote-provider availability.

Development Vite uses TRUST_RUNTIME_URL/TRUST_WEB_PORT and TRUST_MOBILE_UPSTREAMS. The retained trust-test tmux manager additionally uses TRUST_SERVER_PORT, TRUST_SERVER_STATE_DIRECTORY, TRUST_SERVER_TMUX_SESSION, TRUST_WEB_TMUX_SESSION and sample-project paths; these manage a development environment, not the production shell contract. Playwright ports/restart controls, fixture database URLs, sample-build variables and private development-provider knobs remain test/development inputs. No retained process or secret configuration was changed for this inventory.

## Agreed implementation contract

The shared file is selected explicitly by absolute `TRUST_CONFIG_FILE`. Canonical sections are `server`, `storage`, `authentication`, `logging`, `runner`, and `shell`. It is partial input: merge exact environment overrides, then defaults, then validate the complete effective configuration before bind/write/start. Unknown fields and malformed values fail with field names, never secret values. Arrays replace as values. There is no watch/reload endpoint.

The canonical typed contract and pure resolver belong to the standalone SDK; runtime, shell and Runner import directly, with filesystem reads at host boundaries. Authentication/storage types have one owner. Shell defaults such as state-relative storage, operation catalog and log paths are derived once and never overwrite explicit file/environment values during child spawn. Relative non-secret paths resolve at the launching host against its working directory; configuration-file and credential-file paths retain their explicit absolute constraints. API-injected dependencies (clock, fetch, database instance, secret resolver, logger, precompiled Operations) stay code composition, not JSON settings.

Helm uses `values.config` as the same canonical object, with explicit environment overrides and existingSecret references. PostgreSQL connectionString and web password are omitted from public ConfigMaps. `storage:{kind:postgresql}` plus secret `TRUST_DATABASE_URL` is valid after merge. Container/service/probe ports derive from the same config. Canonical JSON Schema is exported beside the resolver; chart schema generation checks its copy against that authority. The chart uses one replica with a nonoverlapping rollout, external PostgreSQL, provider-neutral shared authentication, writable state, and preserves externally configured semantic authority. Container/image and chart work belongs to the Helm worker.

Effective configuration is inspectable through a local CLI report with source provenance (environment/file/default) and redaction; the report never loads credential contents and is not a remotely readable secret/configuration endpoint. Reporting configuration is not starting a server. Public acceptances must separately prove startup, transport/auth/extensions, database ownership and existing runtime updates. The mission's unit-labelled group invokes the actual server CLI; it does not add unit tests.

## Status

Inventory and cross-worker contract agreed; implementation is now authorized following closure of the ABAC freeze. No configuration acceptance, container build, Kubernetes installation, retained activation, commit or publication is claimed by this inventory.
