# Configuring a TRUST server and Runner

TRUST loads startup configuration once. Set `TRUST_CONFIG_FILE` to an absolute JSON file. The file uses the canonical `TrustConfiguration` fields owned by `@trust/extension-sdk`; `TRUST_CONFIGURATION_SCHEMA` describes file input. **An explicit environment value overrides its file field; the file overrides the documented default.** Invalid effective values fail startup. Unknown JSON fields fail even when another field has an environment override. Arrays and maps are replaced, not appended or deep-merged. Authentication is replaced as one complete section by `TRUST_AUTHENTICATION` JSON.

For example, an operator can mount [shared.json](../../assets/configuration/shared.json), set `TRUST_CONFIG_FILE` to that mounted absolute path, and inject `TRUST_DATABASE_URL` through an existing Kubernetes Secret. The file's PostgreSQL target is completed by that environment value before required-field validation. Never include a credential-bearing URL in a public ConfigMap. [local.json](../../assets/configuration/local.json) selects explicit local mode and an embedded store.

Use `trust server config` to inspect the effective shell configuration and its `sources` map without starting a listener or opening a database. The runtime entry supports `--print-config`; the packaged Runner supports `run.js --print-config`. Database connection strings and the Basic web password are always redacted. Credential file contents are never loaded by a configuration report. Authentication provenance is reported at section level because it is replaced atomically. Derived paths show their source as default and their actual resolved path as the value. These local reports are not remotely accessible configuration endpoints.

```sh
TRUST_CONFIG_FILE=/etc/trust/config.json node packages/trust-shell/bin/trust.js server config
TRUST_CONFIG_FILE=/etc/trust/config.json node packages/trust-shell/bin/trust.js server start
TRUST_CONFIG_FILE=/etc/trust/config.json node packages/trust-shell/bin/trust.js server status
```

The shell starts one runtime child and serves the web assets/proxy. Desktop uses the same loader and shell. File and environment choices for semantic authority, catalog, storage and log paths survive that child launch. IPv6 bind addresses are raw (for example `::1`), while URLs bracket them. The existing Check URI grammar accepts DNS/IPv4 authorities; startup requires an explicit public DNS/IPv4 semantic authority with an IPv6 bind. Bind address, public semantic authority and client endpoint are separate values: `0.0.0.0` is a bind address, while an externally routed Check URI should use the configured public authority.

## Field reference

All fields below are startup-only and require a restart of the relevant process to change. File paths other than the configuration selector, credential file and installation root are resolved against the launching process's working directory. Deployments should use absolute paths. Empty strings are rejected rather than silently selecting a fallback. Durations are positive integers in milliseconds, at most 2147483647, the supported timer bound; port ranges are specified separately.

| File field | Environment override | Default and validation | Owner / sensitivity |
| --- | --- | --- | --- |
| `server.host` | `TRUST_HOST` | `127.0.0.1`; nonempty host without URL components | Runtime/shell, public |
| `server.port` | `TRUST_PORT` | 4318; 1–65535 in shell, 0–65535 for direct runtime (0 requests ephemeral port) | Runtime, public |
| `server.webPort` | `TRUST_WEB_PORT` | 4173; 1–65535, differs from runtime port in shell | Shell, public |
| `server.stateDirectory` | `TRUST_SERVER_STATE_DIRECTORY` | `.trust/server`; Desktop default is `<userData>/server` | Shell, public path |
| `server.semanticAuthority` | `TRUST_SEMANTIC_AUTHORITY` | Shell bind host:runtime port; direct runtime `localhost:4318`; lowercase DNS/IPv4 authority only under the existing Check URI grammar, no scheme/path/query | Check URI construction, public |
| `server.operationsDirectory` | `TRUST_OPERATIONS_DIRECTORY` | Shell `<state>/operations`; direct runtime unset | Operation catalog, public path |
| `server.extensionsFile` | `TRUST_EXTENSIONS_FILE` | Unset (no installed extensions) | Extension host, public registry path |
| `server.sessionDurationMs` | `TRUST_SESSION_DURATION_MS` | 86400000 | Sessions, public technical lifetime |
| `server.trialTimeoutMs` | `TRUST_TRIAL_TIMEOUT_MS` | 600000 | Trial process, public |
| `server.extensionTimeoutMs` | `TRUST_EXTENSION_TIMEOUT_MS` | 10000, existing host IPC timeout | Extension host, public |
| `server.runnerTrialScript` | `TRUST_RUNNER_TRIAL_SCRIPT` | Packaged Runner trial script relative to installed runtime/shell | Trial launch, public path |
| `server.diagnosticsEndpoint` | `TRUST_DIAGNOSTICS_ENDPOINT` | Current bind origin `/otlp/diagnostics`; determined after bind for ephemeral runtime port | Trial diagnostics, public URL; shared must stay on runtime origin |
| `storage.kind` | `TRUST_STORAGE` | `pglite` or `postgresql`, default pglite | Database, public |
| `storage.directory` | `TRUST_PGLITE_DIRECTORY` | Shell `<state>/pglite`; direct runtime `.trust/pglite`; only PGlite | Database, public path |
| `storage.connectionString` | `TRUST_DATABASE_URL` | Required with PostgreSQL; postgres/postgresql URL; excludes PGlite directory | Database, **secret/redacted** |
| `authentication` | `TRUST_AUTHENTICATION` | Complete JSON object; default explicit local profile/access | Authority, public settings and credential references |
| `logging.level` | `TRUST_LOG_LEVEL` | info; fatal/error/warn/info/debug/trace/silent | Both processes, public |
| `logging.runtimePath` | `TRUST_RUNTIME_LOG_PATH` | Shell `<state>/runtime.log`; direct runtime stderr | Runtime diagnostics path |
| `logging.runnerPath` | `TRUST_RUNNER_LOG_PATH` | `<state>/runner.log` | Runner diagnostics path |
| `runner.rpcEndpoint` | `TRUST_RPC_ENDPOINT` | `http://127.0.0.1:4318/rpc` | Runner, public URL |
| `runner.otlpEndpoint` | `TRUST_OTLP_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` | Runner, public URL |
| `runner.authFile` | `TRUST_AUTH_FILE` | Unset; absolute private credential file when shared | Runner, path only; contents secret |
| `runner.shellTimeoutMs` | `TRUST_SHELL_TIMEOUT_MS` | 600000, strict integer; passed explicitly to Shell execution | Runner, public |
| `runner.additionalPath` | `TRUST_RUNNER_ADDITIONAL_PATH` | Empty absolute-directory array; JSON array override replaces the file array | Runner child PATH; public |
| `shell.installRoot` | `TRUST_INSTALL_ROOT` | Search checkout/package ancestors; explicit selection absolute | Shell/Runner deployment, public path |
| `shell.url` | `TRUST_URL` | `http://<host>:<webPort>` | Registry CLI client, public URL |
| `shell.webAccessPassword` | `TRUST_WEB_ACCESS_PASSWORD` | Unset; at least 20 characters, local auth only | Outer Basic gate, **secret/redacted** |
| `shell.mobileUpstreams` | `TRUST_MOBILE_UPSTREAMS` | Empty JSON map; exact `http://127.0.0.1:<port>` origins, `pathMode` strip/default or preserve | Shell gateway, public |

The shell CLI has no `--host` or `--port` options. The Runner's existing repeatable `--path` arguments append explicit directories after the configured `runner.additionalPath`; neither replaces the system PATH. Programmatic shell options are trusted composition overrides; the configuration file/environment contract applies to operator startup. The explicit `stateDirectory` API argument supplies a default, so a selected file/environment directory still wins. Injected clocks, databases, fetch functions, secret resolvers, loggers and precompiled Operations are code dependencies, not serialized settings.

`TRUST_RUNTIME_INSTANCE` is a shell-generated child correlation marker. `TRUST_RUNNER_PROCESS_GROUP` is an internal Trial process-group marker. Neither is a user identity or configurable permission. PostgreSQL pool size eight, dedicated ownership connection, 5000ms connection timeout, HTTP body limits and provider-cache durations remain implementation constants, not operator knobs.

## Authentication configuration

The section is `{profile,access,browser?,resourceUrl?}`. Explicit local profile has only local access and cannot carry shared settings. Development/shared profiles require nonlocal access and a protected resource URL. Shared requires HTTPS authority/browser URLs and refuses development loopback allowances. Development permits explicitly configured loopback HTTP; it does not make arbitrary plaintext remote authorities valid.

Access settings are `mode`, `issuer`, `audience`, optional `discovery` (oidc default/oauth), `clockToleranceSeconds` (0, range 0–60), `maxTokenAgeSeconds` (300, range 1–86400), `timeoutMs` (5000, range 100–30000), and `allowInsecureLoopback` (false). JWT mode additionally accepts asymmetric `algorithms` (RS256 default) and `tokenProfile` (at+jwt default; alternate type requires explicit required claim discriminators). Introspection additionally requires clientId and `{environment,name}` clientSecretReference; authenticationMethod defaults to client_secret_basic and may be client_secret_post. The secret is resolved through the existing CredentialService. Bootstrap that existing reference through authorized provisioning before enabling introspection; this change adds no secret-bootstrap or permission bypass.

Browser configuration contains issuer, public clientId, redirectUri, postLogoutRedirectUri, scope and optional resource. Issuer must match access; redirects share an origin. It never accepts a client secret. The closed canonical schema rejects unknown nested fields; runtime validation additionally checks related URLs and profile-specific policy. Helm embeds that same generated schema, then the runtime validates the environment-completed effective configuration.

`TRUST_AUTH_CONFIG_FILE` is retired and fails with migration guidance. Move its JSON object under `authentication` in the common `TRUST_CONFIG_FILE`. The development issuer script now writes `runtime-configuration.json` in that shape. No retained process is reconfigured automatically. `TRUST_DATABASE_PATH` likewise remains rejected: explicitly import retained SQLite using the established data-preserving workflow before selecting a new store.

## Runner and existing runtime updates

A Runner-only file may contain `runner` and `logging` sections. Shared Runner credentials remain private `TRUST_AUTH_FILE` data, bound to the RPC/OTLP origin with exact `/rpc` and `/v1/traces` paths. Tokens are not accepted through `TRUST_ACCESS_TOKEN`, `TRUST_REFRESH_TOKEN` or `TRUST_AUTHORIZATION`. Credential refresh updates that private file; startup configuration is not reloaded. Runner login's explicit private enrollment file is a separate OAuth enrollment operation, not another server startup contract.

Changing the file while a process runs has no effect. Restart applies the new startup values and preserves the selected database. Business Environment values, named credentials, registry sources and extension lifecycle retain their existing authorized public update operations; they are not overwritten from startup JSON. Plan roots, ownership and declaration semantics remain unchanged. A general extension-use grant does not imply any Plan or lifecycle permission.

Only one runtime may own a database. Chart installation therefore uses one replica and a nonoverlapping rollout; PostgreSQL is external, not managed or seeded by configuration. The shell still needs writable state for catalog files and logs. `/health` is available after initialization (503 while starting); it is not a continuous database query or external-provider readiness assertion. See [inventory](../architecture/server-configuration-inventory-2026-09-26.md) for development-only variables and extension-specific manifests.
