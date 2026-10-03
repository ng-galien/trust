# Author an extension

## Prerequisites and outcome

Read the [minimal public SDK guide](../../packages/trust-extension-sdk/README.md).
The optional example is [Dragon Heist](../../extensions/dragon-heist/README.md). The outcome is an
independently compiled extension using public contracts, with lifecycle and
integration behavior verified at the host boundary. Distribution bundles are a
separate, deferred task.

## Steps

1. Define what belongs to the integration. External domain storage,
   domain consistency and external actions remain outside TRUST. The extension
   never qualifies Checks or accesses the runtime's database implementation.
2. Import SDK contracts with `import type`. Implement `ExtensionFactory` and its
   lifecycle; use `ExtensionPageProps` for the federated page. Import Operation
   and Procedure contracts from their canonical packages and matcher values from
   their `/match` entrypoints. Do not copy closed unions or add consumer re-export
   barrels. Validate JSON at transport boundaries; types do not validate JSON.
3. Read the target extension's manifest and implementation when editing. Declare
   configuration, requested capabilities, optional MCP commands and the federated
   module through the SDK contracts. If an example is needed, inspect the
   [Dragon manifest](../../extensions/dragon-heist/extension.json) and only the
   relevant lifecycle or capability implementation in its
   [server](../../extensions/dragon-heist/server.mjs). Do not introduce a custom host protocol.
4. Keep prepare, start and stop distinct. Prepare requires an explicit operator
   action; start must not silently initialize or replace incompatible storage.
   Stop releases owned resources, not independent Runners or TRUST history.
5. Keep credentials out of browser props and public catalogs. Read granted Plan
   projections through the host capability: the page's `trustBase` surfaces, or
   `ExtensionContext.trust` on the server with the invocation context in progress. Notifications trigger rereads; they
   are not authoritative state. Treat unavailable projections as unavailable,
   never infer a terminal Plan state from an external response.
6. Use the host navigation functions when supplied for Plan and Procedure links.
   Preserve the page's search state through the supplied navigation contract;
   do not reconstruct routing in every extension.
7. Build the extension and verify the packaged SDK independently of the server.
   Then test prepare/start/stop, declared commands, denied capabilities, event
   rereads, reconnection and real federation navigation with the public host.

## Optional example

Dragon's `ExtensionFactory` owns a separate SQLite game database. Its manifest
requests `plans.read` and `plans.subscribe`; its HTTP Operations use the same
validated command service exposed through the extension. The page receives
`apiBase`, `trustBase`, `eventsUrl` and navigation helpers, not server internals.
Follow its existing README for installation, configuration and build commands;
do not execute its demo launcher against the shared preview as a documentation test.

The SDK's [standalone package acceptance](../../packages/trust-extension-sdk/acceptance/package.acceptance.test.mjs)
compiles an extension fixture without installing the runtime. This proves package
consumption, not domain execution. Dragon's
[HTTP acceptance](../../extensions/dragon-heist/acceptance/http.acceptance.test.mjs)
adds real host, Runner and OTLP behavior.

## Failure handling

A child-process boundary limits ordinary crashes and hanging hooks; it is not a
sandbox for malicious extension code. Browser federation shares the host's
JavaScript environment. Install trusted code only. Fix mismatched capabilities,
configuration or contract versions explicitly rather than importing runtime
implementation to bypass the SDK.

## Stop and report

Return the changed extension files, build result, public scenarios actually run
and remaining failures. Install or prepare the extension only when the assignment
includes those actions. Stop after the requested implementation or validation;
do not launch a demonstration or change shared storage as a completion step.
