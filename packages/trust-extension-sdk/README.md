# Minimal extension SDK guide

`@trust/extension-sdk` is the public, type-only contract surface for TRUST
extensions and clients. It contains no server implementation and imports no
runtime package. Compile an extension against this package and the language
contract packages, without compiling or installing the server.

The SDK owns public Plan views, execution results, event payloads, extension
lifecycle hooks, installation declarations and federated page props. The runtime
implements these contracts; its persistence models and services remain internal.
Operation and Procedure language definitions remain owned by their respective
packages and are referenced, never redefined here.

Use `import type` for SDK contracts. For example, implement `ExtensionFactory`
for the server module and `ExtensionPageProps` for the federated page. List
responses contain `PlanSummaryView`; a Plan detail is `PlanView`. They are not
interchangeable: summaries contain `checkCount`, details contain `checks`, and
only details carry the full active escalation.

`npm run test:acceptance --workspace=@trust/extension-sdk` verifies the packaged
declarations against a standalone extension fixture outside the workspace, with
no runtime package installed. This is a package consumption check, not evidence
that an extension's external actions or TRUST execution behave correctly.

## Dependencies

Consume the built `@trust/extension-sdk` package as a development dependency for
types. The packages in this repository are private workspace packages; this guide
does not claim they are published to npm. The package acceptance below demonstrates
consumption from local package archives outside the workspace.

Use the canonical `@trust/operation` and `@trust/procedure` packages when your
extension needs their language contracts. Import matcher values from `/match`.
Do not install or compile `@trust/runtime`, import its internals, or create local
copies of its public views. Your own server and browser build tools are separate
from these type contracts; the SDK provides no scaffold or runtime client library.

## Minimal server module

The host loads the named `createExtension` export. All four lifecycle methods
below are required; `command` is optional. This read-only example owns no storage
and requests no Plan capabilities:

```typescript
import type { ExtensionFactory } from "@trust/extension-sdk";

export const createExtension: ExtensionFactory = () => ({
  async prepare() {},
  async start() {},
  async stop() {},
  async read() {
    return { status: 200, body: { message: "Example extension" } };
  },
});
```

Compile or bundle this module as ESM. `prepare` performs explicitly requested
initialization; `start` acquires resources and `stop` releases them. Do not silently
reset storage during start. The context supplies the effective settings values as
`configuration`, the selected Environment name and `publishChanged()`; it does not
expose runtime services. When the selected store has no schema, `start` throws an
error whose `failure` is `"storage-unprepared"`; when its schema is incompatible,
`prepare` and `start` throw with `"storage-incompatible"` and leave it unchanged.

Place the resulting module beside a manifest:

```json
{
  "contract": "trust.extension@1",
  "id": "example",
  "title": "Example",
  "version": "1.0.0",
  "server": "./server.mjs",
  "settings": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "databasePath": { "type": "string", "format": "absolute-path" },
      "databaseUrl": { "type": "string", "format": "uri" },
      "apiToken": { "type": "string", "format": "environment-credential", "enum": ["EXAMPLE_API_TOKEN"] },
      "pollSeconds": { "type": "integer", "minimum": 1, "default": 30 }
    },
    "oneOf": [{ "required": ["databasePath"] }, { "required": ["databaseUrl"] }]
  },
  "requestedCapabilities": []
}
```

`settings` is a closed JSON Schema subset (`ExtensionSettingsSchema`): typed
`string`/`integer`/`number`/`boolean` properties, `required`, `default`, and the
cross-field constraints `oneOf`, `anyOf` (branches of `required`) and
`dependentRequired`. A credential is never a value: an `environment-credential`
setting names one of the environment variables listed in its `enum`, and the host
resolves it when it starts a new instance. URI settings refuse embedded passwords.
`validateExtensionSettings` reports every issue with a JSON Pointer and a message.

An operator adds its absolute manifest path to the installation file configured
by `TRUST_EXTENSIONS_FILE`. Each installation declares its initial settings values
under `configuration`, `environment` and `grants`; `credentialEnvironment` and
`autoStart` are optional. Once updated through `PUT /extensions/{id}/settings` or
the `trust_extension_settings_update` MCP tool (revision-checked), the runtime
database holds the values. An update stops the instance, renews it with the new
values and restarts it if it was running; a newly selected store without schema
reports `preparationRequired` and waits for an explicit `prepare`. Reads return
credential references by name only.
Relative server/UI asset paths must remain inside the extension directory.
Only install trusted code: the child process and federated browser page are not a
security sandbox.

## Optional capabilities, commands and page

- Request `plans.read`, `plans.subscribe`, `plans.declare` or `catalog.read` only
  when needed; the operator grants a subset. The host exposes Environment-filtered
  Plan reads and notifications and exact catalog reads, not direct database access.
  Missing grants must remain refusals.
- Optional manifest `mcp` declares named commands and closed input schemas.
  Implement lifecycle `command` to handle their validated requests. The running
  extension contributes one MCP tool; the public HTTP command route uses the same
  handler. Transport inputs still require validation; TypeScript is not JSON validation.
- Optional `ui` declares the federation `name`, `entry`, `module` and `assets`.
  The exported page receives `ExtensionPageProps`: `apiBase`, `trustBase`,
  `eventsUrl`, `language`, and optional `navigation`. Render without assuming
  navigation helpers are present. With them, use `planHref`, `procedureHref`,
  `navigate`, `search` and `replaceSearch` rather than inventing host URLs.
- `publishChanged()` signals external-data changes. On initial connection,
  reconnection and notifications, reread authorized state. Signals are not Facts
  or authoritative state. External completion does not qualify a Check.
- Credentials belong to the installation's allowed process environment, never
  browser props, manifest values or public catalog output.

For one complete optional example, inspect the
[coordination manifest](../../extensions/coordination/extension.json) and
[lifecycle guide](../../extensions/coordination/README.md). Its PostgreSQL storage
is an example choice, not an SDK requirement. See the
[authoring task guide](../../docs/agents/author-extension.md) for verification and
the independent [package acceptance](acceptance/package.acceptance.test.mjs) for
the executable contract check.

## TRUST access from the extension server

`ExtensionContext.trust` gives the server process the same granted surfaces as the
page: `listPlans`, `readPlan` and `readEpisode` (`plans.read`),
`replaceDeclarations` (`plans.declare`), and `readProcedure` / `readOperation` for
one exact published version (`catalog.read`). Each call passes the
`ExtensionInvocationContext` of the `read` or `command` in progress: the host
applies that caller's access, the installation grants and the installation
Environment, and calls the same runtime services as RPC/MCP. A context kept after
its invocation returns is refused with `invocation-ended`; there is no background
identity. Refusals are `ExtensionTrustError` with a closed `failure`; a Plan outside
the caller's rights or the Environment is `not-found`. Executing an Operation stays
the Runner's role.

A `read` or `command` that exceeds the installation time limit fails alone with 504;
the host fails the process only when it no longer answers a liveness probe.

## Plan inputs from extension forms

An installation may explicitly request and grant `plans.declare`. Its page can
POST to `${trustBase}/plans/{plan}/declarations` using the canonical
`PlanDeclarationReplacementInput` contract. The host validates the JSON boundary,
requires extension-use access and the grant, confines the Plan to the installation
Environment, and calls the same `PlanRuntime.replaceDeclarations` service as
RPC/MCP with the requesting principal. Core ownership and action permissions still
apply. This is not a proxy to RPC, an arbitrary context patch or a live Fact input.

Send the complete current scalar declarations with `expectedRevision`; preserve
unrelated roles. Omit `missionDeclarations` to leave accepted collections intact.
A stale revision returns 409; reread instead of silently rebasing a user's draft.
Only Procedure-declared roles may change. Roots, fixed roles and observed outputs
remain outside this surface. A successful submission records Plan inputs, not
qualification. Use `plans.read` to reread declarations and qualified results and
`plans.subscribe` for change notifications. The extension need not store answers.
