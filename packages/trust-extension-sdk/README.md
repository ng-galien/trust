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
reset storage during start. The context supplies string configuration, the selected
Environment name and `publishChanged()`; it does not expose runtime services.

Place the resulting module beside a manifest:

```json
{
  "contract": "trust.extension@1",
  "id": "example",
  "title": "Example",
  "version": "1.0.0",
  "server": "./server.mjs",
  "configuration": {},
  "requestedCapabilities": []
}
```

An operator adds its absolute manifest path to the installation file configured
by `TRUST_EXTENSIONS_FILE`. Each installation declares `configuration`,
`environment` and `grants`; `credentialEnvironment` and `autoStart` are optional.
Relative server/UI asset paths must remain inside the extension directory.
Only install trusted code: the child process and federated browser page are not a
security sandbox.

## Optional capabilities, commands and page

- Request `plans.read` or `plans.subscribe` only when needed; the operator grants
  a subset. The host exposes Environment-filtered Plan reads and notifications,
  not direct database access. Missing grants must remain refusals.
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
