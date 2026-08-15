# TRUST Language Server

The TRUST Language Server exposes the source models owned by the TRUST language packages through
the standard Language Server Protocol.

## Current surface

- Microsoft `vscode-languageserver` over STDIO;
- incremental text synchronization;
- Operation diagnostics from `@trust/operation`;
- Operation document symbols from the positioned Operation source model.

The server contains no Operation grammar, parser or validation rule. Completion, hover and later
Procedure support will be added only when their language package exposes the required source data.

## Verification

```sh
npm run test:acceptance --workspace=@trust/language-server
```

The acceptance starts the compiled server as a real process and drives it through JSON-RPC with
Microsoft `vscode-jsonrpc`. It covers the valid Operation catalogue, every invalid Operation
fixture, incremental edits, recovery, document close and unrelated Gherkin documents.
