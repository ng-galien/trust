# Extension contracts

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
